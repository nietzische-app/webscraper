/**
 * Export helpers — writes scraped data to local .json / .csv files.
 */

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import csv from "csv-writer";

export type ExportFormat = "json" | "csv";

/** UTF-8 byte order mark. */
const BOM = "\uFEFF";

export interface ExportResult {
  filePath: string;
  format: ExportFormat;
  records: number;
  bytes: number;
  columns?: string[];
}

/** Where relative output paths land. Override with SCRAPER_OUTPUT_DIR. */
export function defaultOutputDir(): string {
  const configured = process.env.SCRAPER_OUTPUT_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.resolve(os.homedir(), "scraper-output");
}

/** Resolves a user-supplied path against the output dir and appends the right extension. */
export function resolveOutputPath(filePath: string, format: ExportFormat): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("An output file path is required.");
  const resolved = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(defaultOutputDir(), trimmed);
  const ext = path.extname(resolved).toLowerCase();
  return ext === `.${format}` ? resolved : `${resolved}.${format}`;
}

/** Infers the format from the extension, defaulting to JSON. */
export function formatFromPath(filePath: string, fallback: ExportFormat = "json"): ExportFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  return fallback;
}

/**
 * Flattens one level of nesting so nested objects and arrays survive the trip
 * into a CSV cell (`price.value` -> column, `tags` -> "a; b; c").
 */
export function flattenRecord(record: unknown, prefix = ""): Record<string, string> {
  const flat: Record<string, string> = {};

  if (record === null || record === undefined) return flat;
  if (typeof record !== "object") {
    flat[prefix || "value"] = String(record);
    return flat;
  }

  if (Array.isArray(record)) {
    flat[prefix || "value"] = record
      .map((entry) => (entry !== null && typeof entry === "object" ? JSON.stringify(entry) : String(entry ?? "")))
      .join("; ");
    return flat;
  }

  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    const column = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      flat[column] = "";
    } else if (Array.isArray(value)) {
      flat[column] = value
        .map((entry) => (entry !== null && typeof entry === "object" ? JSON.stringify(entry) : String(entry)))
        .join("; ");
    } else if (typeof value === "object") {
      Object.assign(flat, flattenRecord(value, column));
    } else {
      flat[column] = String(value);
    }
  }

  return flat;
}

/** Normalises whatever the tools produced into an array of CSV rows. */
export function toRecordArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((entry) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : { value: entry },
    );
  }
  if (data !== null && typeof data === "object") {
    // Common wrapper shapes from the scraper: use the payload array if there is one.
    const record = data as Record<string, unknown>;
    for (const key of ["items", "results", "rows", "data", "emails", "downloaded"]) {
      const candidate = record[key];
      if (Array.isArray(candidate) && candidate.length > 0) return toRecordArray(candidate);
    }
    return [record];
  }
  return [{ value: data }];
}

export async function exportToJson(data: unknown, filePath: string): Promise<ExportResult> {
  const resolved = resolveOutputPath(filePath, "json");
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const { size } = await stat(resolved);
  return {
    filePath: resolved,
    format: "json",
    records: Array.isArray(data) ? data.length : 1,
    bytes: size,
  };
}

export async function exportToCsv(data: unknown, filePath: string): Promise<ExportResult> {
  const resolved = resolveOutputPath(filePath, "csv");
  const records = toRecordArray(data);
  if (records.length === 0) throw new Error("Nothing to export: the dataset is empty.");

  const rows = records.map((record) => flattenRecord(record));

  // Union of every key, in first-seen order, so ragged records still line up.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  await mkdir(path.dirname(resolved), { recursive: true });

  const writer = csv.createObjectCsvWriter({
    path: resolved,
    header: columns.map((column) => ({ id: column, title: column })),
    encoding: "utf8",
    append: false,
  });

  await writer.writeRecords(rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? ""]))));

  // Excel only reads UTF-8 CSVs correctly (Turkish characters, €, ₺) when a BOM
  // is present. Set SCRAPER_CSV_BOM=false for tooling that dislikes it.
  if (process.env.SCRAPER_CSV_BOM !== "false") {
    const content = await readFile(resolved, "utf8");
    if (!content.startsWith(BOM)) await writeFile(resolved, `${BOM}${content}`, "utf8");
  }

  const { size } = await stat(resolved);

  return { filePath: resolved, format: "csv", records: rows.length, bytes: size, columns };
}

/** Single entry point used by the `export_to_file` MCP tool. */
export async function exportData(
  data: unknown,
  filePath: string,
  format?: ExportFormat,
): Promise<ExportResult> {
  const target = format ?? formatFromPath(filePath, "json");
  return target === "csv" ? exportToCsv(data, filePath) : exportToJson(data, filePath);
}
