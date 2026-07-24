/**
 * HTTP API tests. Boots the compiled Express server on an ephemeral port and
 * drives it against the local fixture site. Run after `npm run build`.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startFixtureServer } from "./fixture-server.js";

let fixture;
let baseUrl;
let apiBase;
let apiServer;
let outputDir;
let browserManager;

before(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "scraper-api-"));
  process.env.SCRAPER_OUTPUT_DIR = outputDir;

  fixture = await startFixtureServer();
  baseUrl = fixture.baseUrl;

  // Imported after the env var is set: defaultOutputDir() reads it lazily, but
  // the module-level PORT/HOST constants are read at import time.
  const serverModule = await import("../build/server.js");
  ({ browserManager } = await import("../build/scraper.js"));
  apiServer = await serverModule.startServer(0, "127.0.0.1");
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
});

after(async () => {
  apiServer?.close();
  await browserManager?.close();
  fixture?.server.close();
});

async function post(endpoint, body) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(endpoint) {
  const response = await fetch(`${apiBase}${endpoint}`);
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: response.headers,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
}

/** Polls a job until it leaves the queued/running state. */
async function waitForJob(jobId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get(`/api/jobs/${jobId}`);
    if (body.status === "done" || body.status === "error") return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out in state ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("GET /api/health reports server state", async () => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.outputDir, outputDir);
  assert.equal(body.authRequired, false);
  assert.equal(typeof body.jobs.maxConcurrent, "number");
});

test("GET / serves the dashboard", async () => {
  const { status, body } = await get("/");
  assert.equal(status, 200);
  assert.match(body, /Universal Web Scraper/);
  assert.match(body, /Kazımayı Başlat/);
});

test("POST /api/scrape queues a job and reports its result", async () => {
  const { status, body } = await post("/api/scrape", { url: `${baseUrl}/iletisim`, type: "leads" });
  assert.equal(status, 202);
  assert.ok(body.jobId, "must return a job id");

  const job = await waitForJob(body.jobId);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.type, "leads");
  assert.ok(job.counts.emails >= 3, `emails: ${job.counts.emails}`);
  assert.ok(job.result.emails.includes("info@test-firma.com"));
  assert.ok(job.result.phones.some((phone) => phone.normalized === "+902121234567"));
  assert.ok(job.durationMs > 0);
});

test("POST /api/scrape?wait=1 blocks until the job finishes", async () => {
  const response = await fetch(`${apiBase}/api/scrape?wait=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${baseUrl}/tablo`, type: "list", options: { itemSelector: "table tbody tr" } }),
  });
  const job = await response.json();
  assert.equal(response.status, 200);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.result.itemCount, 3);
  assert.deepEqual(job.result.items[0], { Model: "A-100", Stok: "12", Fiyat: "$199.99" });
});

test("list scrape paginates and exports to CSV, which is then downloadable", async () => {
  const started = await post("/api/scrape", {
    url: `${baseUrl}/urunler?page=1`,
    type: "list",
    options: { maxPages: 2, itemSelector: ".product-card" },
  });
  const job = await waitForJob(started.body.jobId);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.counts.items, 12);

  const exported = await post("/api/export", { jobId: job.id, format: "csv", fileName: "urunler-test" });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.records, 12);
  assert.equal(exported.body.file, "urunler-test.csv");

  const download = await get(exported.body.url);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /urunler-test\.csv/);
  assert.match(download.body, /Ürün 7/);

  const listed = await get("/api/files");
  assert.ok(listed.body.files.some((file) => file.file === "urunler-test.csv"));
});

test("inline export writes arbitrary data", async () => {
  const exported = await post("/api/export", {
    data: [{ ad: "Ali", puan: 5 }, { ad: "Ayşe", puan: 9, not: "ek kolon" }],
    format: "csv",
    fileName: "inline-test",
  });
  assert.equal(exported.status, 200);
  const csv = await readFile(path.join(outputDir, "inline-test.csv"), "utf8");
  assert.match(csv, /ad,puan,not/);
  assert.match(csv, /Ayşe,9,ek kolon/);
});

test("image scrape exposes per-file download URLs", async () => {
  const started = await post("/api/scrape", {
    url: `${baseUrl}/galeri`,
    type: "images",
    options: { minWidth: 100, minHeight: 100, outputFolder: "api-galeri" },
  });
  const job = await waitForJob(started.body.jobId);
  assert.equal(job.status, "done", job.error ?? "");
  assert.equal(job.counts.downloaded, 2);

  const first = job.result.downloaded[0];
  assert.ok(first.downloadUrl.startsWith("/api/download/api-galeri/"), first.downloadUrl);

  const response = await fetch(`${apiBase}${first.downloadUrl}`);
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 1024);
});

test("a failing scrape is reported as an errored job, not a crash", async () => {
  const started = await post("/api/scrape", {
    url: `${baseUrl}/tablo`,
    type: "list",
    options: { itemSelector: ".nope" },
  });
  const job = await waitForJob(started.body.jobId);
  assert.equal(job.status, "error");
  assert.match(job.error, /matched no usable items/);

  const health = await get("/api/health");
  assert.equal(health.body.status, "ok", "server must still be serving");
});

test("invalid payloads are rejected with 400", async () => {
  const missingUrl = await post("/api/scrape", { type: "list" });
  assert.equal(missingUrl.status, 400);
  assert.ok(missingUrl.body.details.some((detail) => detail.includes("url")));

  const badType = await post("/api/scrape", { url: baseUrl, type: "everything" });
  assert.equal(badType.status, 400);

  const unknownJob = await get("/api/jobs/does-not-exist");
  assert.equal(unknownJob.status, 404);
});

test("download refuses to escape the output directory", async () => {
  const secretPath = path.join(outputDir, "..", "outside-secret.txt");
  await writeFile(secretPath, "TOP SECRET", "utf8");

  for (const attempt of [
    "/api/download/../outside-secret.txt",
    "/api/download/%2e%2e%2foutside-secret.txt",
    "/api/download/nested/../../outside-secret.txt",
    `/api/download/${encodeURIComponent("/etc/passwd")}`,
  ]) {
    const response = await fetch(`${apiBase}${attempt}`, { redirect: "manual" });
    assert.ok(response.status === 400 || response.status === 404, `${attempt} → ${response.status}`);
    const text = await response.text();
    assert.ok(!text.includes("TOP SECRET"), `${attempt} leaked the file`);
    assert.ok(!text.includes("root:"), `${attempt} leaked /etc/passwd`);
  }
});

test("unknown API endpoints return JSON 404", async () => {
  const { status, body } = await get("/api/nope");
  assert.equal(status, 404);
  assert.match(body.error, /Unknown API endpoint/);
});
