#!/usr/bin/env node
/**
 * Universal Web Scraper — HTTP API + dashboard.
 *
 * A thin Express layer over the same scraper/exporter modules the MCP server
 * uses. Runs on its own port (PORT, default 3050) so it can share a box with
 * other services.
 *
 * Scrapes run as background jobs: POST /api/scrape returns a job id, the
 * dashboard polls GET /api/jobs/:id. Pass ?wait=1 for a blocking call (curl).
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createReadStream } from "node:fs";
import { stat, readdir, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  browserManager,
  downloadImages,
  extractLeads,
  extractStructuredList,
  scrapePageText,
  type FieldSpec,
} from "./scraper.js";
import { defaultOutputDir, exportData, type ExportFormat } from "./exporter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const publicDir = path.join(projectRoot, "public");

const PORT = Number.parseInt(process.env.PORT ?? "3050", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_TOKEN = process.env.SCRAPER_API_TOKEN?.trim() ?? "";
const MAX_CONCURRENT_JOBS = Math.max(1, Number.parseInt(process.env.SCRAPER_MAX_CONCURRENT_JOBS ?? "2", 10));
const MAX_JOBS_KEPT = Math.max(10, Number.parseInt(process.env.SCRAPER_MAX_JOBS_KEPT ?? "100", 10));
const CORS_ORIGIN = process.env.SCRAPER_CORS_ORIGIN?.trim() || "*";

/* -------------------------------------------------------------------------- */
/* Job store                                                                  */
/* -------------------------------------------------------------------------- */

export type JobType = "text" | "leads" | "list" | "images";
export type JobStatus = "queued" | "running" | "done" | "error";

interface Job {
  id: string;
  type: JobType;
  url: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: unknown;
  exports: { file: string; format: ExportFormat; records: number; url: string }[];
}

const jobs = new Map<string, Job>();
const queue: { job: Job; run: () => Promise<unknown> }[] = [];
let running = 0;

function createJob(type: JobType, url: string): Job {
  const job: Job = {
    id: randomUUID(),
    type,
    url,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    result: null,
    exports: [],
  };
  jobs.set(job.id, job);

  // Drop the oldest finished jobs once the store grows past its cap.
  while (jobs.size > MAX_JOBS_KEPT) {
    const oldest = [...jobs.values()].find((entry) => entry.status === "done" || entry.status === "error");
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
  return job;
}

/** Runs at most MAX_CONCURRENT_JOBS browser jobs at a time. */
function pump(): void {
  while (running < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const next = queue.shift()!;
    running += 1;
    const { job, run } = next;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const startedAt = Date.now();

    void run()
      .then((result) => {
        job.result = result;
        job.status = "done";
      })
      .catch((error: unknown) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = "error";
        console.error(`[web] job ${job.id} (${job.type}) failed:`, error);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.durationMs = Date.now() - startedAt;
        running -= 1;
        pump();
      });
  }
}

function enqueue(job: Job, run: () => Promise<unknown>): void {
  queue.push({ job, run });
  pump();
}

function waitForJob(job: Job, timeoutMs: number): Promise<Job> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (job.status === "done" || job.status === "error" || Date.now() > deadline) return resolve(job);
      setTimeout(check, 250);
    };
    check();
  });
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                         */
/* -------------------------------------------------------------------------- */

const fieldSpecSchema = z.object({
  selector: z.string().optional(),
  attr: z.string().optional(),
  regex: z.string().optional(),
});

const scrapeSchema = z.object({
  url: z.string().min(1, "url is required"),
  type: z.enum(["text", "leads", "list", "images"]),
  options: z
    .object({
      // shared navigation options
      waitForSelector: z.string().optional(),
      waitMs: z.number().int().min(0).max(30_000).optional(),
      scrollToBottom: z.boolean().optional(),
      timeoutMs: z.number().int().min(1_000).max(180_000).optional(),
      locale: z.string().optional(),
      // text
      selector: z.string().optional(),
      includeHtml: z.boolean().optional(),
      // leads + list
      maxPages: z.number().int().min(1).max(50).optional(),
      // list
      itemSelector: z.string().optional(),
      fields: z.record(z.string(), fieldSpecSchema).optional(),
      nextPageSelector: z.string().optional(),
      pageUrlPattern: z.string().optional(),
      startPage: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(1).max(10_000).optional(),
      // images
      minWidth: z.number().int().min(0).optional(),
      minHeight: z.number().int().min(0).optional(),
      maxImages: z.number().int().min(1).max(1_000).optional(),
      listOnly: z.boolean().optional(),
      outputFolder: z.string().optional(),
    })
    .default({}),
  export: z.enum(["csv", "json"]).optional(),
});

const exportSchema = z.object({
  jobId: z.string().min(1).optional(),
  data: z.unknown().optional(),
  format: z.enum(["csv", "json"]).default("csv"),
  fileName: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Keeps user-supplied names inside the output directory. */
function safeRelativeName(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[\\]/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function jobSummary(job: Job): Record<string, unknown> {
  const base = {
    id: job.id,
    type: job.type,
    url: job.url,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    error: job.error,
    exports: job.exports,
  };

  const result = job.result as Record<string, unknown> | null;
  if (!result) return { ...base, counts: null };

  const counts: Record<string, number> = {};
  if (job.type === "list") counts.items = Number(result.itemCount ?? 0);
  if (job.type === "leads") {
    counts.emails = (result.emails as unknown[] | undefined)?.length ?? 0;
    counts.phones = (result.phones as unknown[] | undefined)?.length ?? 0;
    counts.socialProfiles = (result.socialProfiles as unknown[] | undefined)?.length ?? 0;
  }
  if (job.type === "images") {
    counts.downloaded = (result.downloaded as unknown[] | undefined)?.length ?? 0;
    counts.found = Number(result.found ?? 0);
  }
  if (job.type === "text") counts.textLength = Number(result.textLength ?? 0);

  return { ...base, counts };
}

/** Text/HTML payloads are trimmed so the dashboard never pulls megabytes of markup. */
function jobPayload(job: Job, full: boolean): Record<string, unknown> {
  const summary = jobSummary(job);
  if (!job.result || full) return { ...summary, result: job.result };

  if (job.type === "images") {
    // Attach a browser-usable download link to every saved file.
    const result = job.result as Record<string, unknown>;
    const outputDir = defaultOutputDir();
    const downloaded = ((result.downloaded as Record<string, unknown>[] | undefined) ?? []).map((image) => {
      const filePath = String(image.filePath ?? "");
      if (!filePath) return image;
      const relative = path.relative(outputDir, filePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return image;
      return { ...image, downloadUrl: `/api/download/${relative.split(path.sep).map(encodeURIComponent).join("/")}` };
    });
    return { ...summary, result: { ...result, downloaded } };
  }

  if (job.type === "text") {
    const result = job.result as Record<string, unknown>;
    const text = String(result.text ?? "");
    return {
      ...summary,
      result: {
        ...result,
        html: undefined,
        text: text.length > 50_000 ? `${text.slice(0, 50_000)}\n…[truncated]` : text,
        links: (result.links as unknown[] | undefined)?.slice(0, 200) ?? [],
      },
    };
  }
  return { ...summary, result: job.result };
}

function runScrapeJob(type: JobType, url: string, options: z.infer<typeof scrapeSchema>["options"]): () => Promise<unknown> {
  const nav = {
    waitForSelector: options.waitForSelector,
    waitMs: options.waitMs,
    scrollToBottom: options.scrollToBottom,
    timeoutMs: options.timeoutMs,
    locale: options.locale,
  };

  switch (type) {
    case "text":
      return () => scrapePageText(url, { ...nav, selector: options.selector, includeHtml: options.includeHtml ?? false });
    case "leads":
      return () => extractLeads(url, { ...nav, maxPages: options.maxPages ?? 1 });
    case "list":
      return () =>
        extractStructuredList(url, {
          ...nav,
          itemSelector: options.itemSelector,
          fields: options.fields as Record<string, FieldSpec> | undefined,
          maxPages: options.maxPages ?? 1,
          nextPageSelector: options.nextPageSelector,
          pageUrlPattern: options.pageUrlPattern,
          startPage: options.startPage,
          maxItems: options.maxItems,
        });
    case "images": {
      const folder = safeRelativeName(options.outputFolder ?? "", `images-${timestampSlug()}`);
      return () =>
        downloadImages(url, path.join(defaultOutputDir(), folder), {
          ...nav,
          minWidth: options.minWidth,
          minHeight: options.minHeight,
          maxImages: options.maxImages,
          listOnly: options.listOnly ?? false,
        });
    }
  }
}

async function exportJobResult(
  data: unknown,
  format: ExportFormat,
  fileName: string,
): Promise<{ file: string; format: ExportFormat; records: number; url: string }> {
  const safeName = safeRelativeName(fileName, `export-${timestampSlug()}`);
  const result = await exportData(data, safeName, format);
  const file = path.basename(result.filePath);
  return { file, format: result.format, records: result.records, url: `/api/download/${encodeURIComponent(file)}` };
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // CORS lets public/index.html work when opened straight from disk (file://,
  // whose Origin is "null") against a server elsewhere. It does not weaken the
  // token: an attacker's page still cannot read a token it does not have, and
  // an open port with no token is reachable directly anyway. Pin it with
  // SCRAPER_CORS_ORIGIN when the panel is served from one known origin.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Optional shared-secret auth. Only guards /api; the dashboard itself is static.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!API_TOKEN) return next();
    if (req.path === "/health") return next();
    const provided =
      (req.get("x-api-token") ?? "").trim() ||
      (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() ||
      String(req.query.token ?? "").trim();
    if (provided === API_TOKEN) return next();
    res.status(401).json({ error: "Unauthorized. Send the API token in the X-API-Token header." });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      version: "1.0.0",
      outputDir: defaultOutputDir(),
      authRequired: Boolean(API_TOKEN),
      jobs: { total: jobs.size, running, queued: queue.length, maxConcurrent: MAX_CONCURRENT_JOBS },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Start a scrape. Returns 202 + job id, or the finished job when ?wait=1.
  app.post("/api/scrape", async (req, res) => {
    const parsed = scrapeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
      });
    }

    const { url, type, options } = parsed.data;
    const job = createJob(type, url);
    const exportFormat = parsed.data.export;

    enqueue(job, async () => {
      const result = await runScrapeJob(type, url, options)();
      if (exportFormat) {
        const name = `${type}-${new URL(url.startsWith("http") ? url : `https://${url}`).hostname}-${timestampSlug()}`;
        job.exports.push(await exportJobResult(result, exportFormat, name));
      }
      return result;
    });

    if (String(req.query.wait ?? "") === "1" || req.query.wait === "true") {
      const timeoutMs = Math.min(Number.parseInt(String(req.query.timeout ?? "300000"), 10) || 300_000, 900_000);
      await waitForJob(job, timeoutMs);
      return res.status(job.status === "error" ? 500 : 200).json(jobPayload(job, String(req.query.full ?? "") === "1"));
    }

    res.status(202).json({ jobId: job.id, status: job.status, poll: `/api/jobs/${job.id}` });
  });

  app.get("/api/jobs", (_req, res) => {
    res.json({ jobs: [...jobs.values()].reverse().map((job) => jobSummary(job)) });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
    res.json(jobPayload(job, String(req.query.full ?? "") === "1"));
  });

  // Write a finished job's result (or inline data) to CSV/JSON.
  app.post("/api/export", async (req, res) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
      });
    }

    const { jobId, data, format, fileName } = parsed.data;
    let payload: unknown = data;
    let defaultName = `export-${timestampSlug()}`;

    if (jobId) {
      const job = jobs.get(jobId);
      if (!job) return res.status(404).json({ error: `Unknown job id: ${jobId}` });
      if (job.status !== "done") return res.status(409).json({ error: `Job is ${job.status}, nothing to export yet.` });
      payload = job.result;
      defaultName = `${job.type}-${timestampSlug()}`;
    } else if (payload === undefined) {
      return res.status(400).json({ error: "Provide either jobId or data." });
    }

    try {
      const exported = await exportJobResult(payload, format, fileName ?? defaultName);
      if (jobId) jobs.get(jobId)?.exports.push(exported);
      res.json(exported);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/files", async (_req, res) => {
    try {
      const dir = defaultOutputDir();
      await mkdir(dir, { recursive: true });
      const entries = await readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const info = await stat(path.join(dir, entry.name));
            return {
              file: entry.name,
              bytes: info.size,
              modifiedAt: info.mtime.toISOString(),
              url: `/api/download/${encodeURIComponent(entry.name)}`,
            };
          }),
      );
      files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      res.json({ outputDir: dir, files });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Download a generated file. Nested paths (image folders) are allowed, but
  // the resolved path must stay inside the output directory.
  app.get(/^\/api\/download\/(.+)$/, async (req, res) => {
    const requested = decodeURIComponent(((req.params as unknown as string[])[0] ?? "").toString());
    const outputDir = defaultOutputDir();
    const resolved = path.resolve(outputDir, requested);
    const relative = path.relative(outputDir, resolved);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return res.status(400).json({ error: "Invalid file path." });
    }

    try {
      const info = await stat(resolved);
      if (!info.isFile()) return res.status(404).json({ error: "Not a file." });
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(resolved).replace(/"/g, "")}"`);
      res.setHeader("Content-Length", String(info.size));
      createReadStream(resolved).pipe(res);
    } catch {
      res.status(404).json({ error: `File not found: ${requested}` });
    }
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API endpoint." }));

  app.use(express.static(publicDir, { index: "index.html", maxAge: "1h" }));

  // Express 5 error handler — keeps a thrown handler from killing the process.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[web] unhandled error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

export async function startServer(port = PORT, host = HOST): Promise<http.Server> {
  await mkdir(defaultOutputDir(), { recursive: true });
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startServer()
    .then((server) => {
      const address = server.address();
      const shownPort = typeof address === "object" && address ? address.port : PORT;
      console.log(`▶ Universal Web Scraper dashboard: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${shownPort}`);
      console.log(`  Output directory : ${defaultOutputDir()}`);
      console.log(`  Concurrent jobs  : ${MAX_CONCURRENT_JOBS}`);
      if (!API_TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost") {
        console.warn(
          "⚠  SCRAPER_API_TOKEN is not set and the server is bound to a public interface.\n" +
            "   Anyone who can reach this port can make your server fetch arbitrary URLs.\n" +
            "   Set SCRAPER_API_TOKEN, bind to HOST=127.0.0.1 behind nginx, or firewall the port.",
        );
      }

      const shutdown = async () => {
        console.error("[web] shutting down…");
        server.close();
        await browserManager.close().catch(() => undefined);
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    })
    .catch((error) => {
      console.error("[web] failed to start:", error);
      process.exit(1);
    });
}
