/**
 * Drives the compiled MCP server over a real stdio transport, exactly the way
 * Claude Desktop / Cursor do. Run after `npm run build`.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startFixtureServer } from "./fixture-server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixture;
let baseUrl;
let client;
let transport;
let outputDir;

before(async () => {
  fixture = await startFixtureServer();
  baseUrl = fixture.baseUrl;
  outputDir = await mkdtemp(path.join(tmpdir(), "scraper-mcp-"));

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "build", "index.js")],
    env: { ...process.env, SCRAPER_OUTPUT_DIR: outputDir },
    stderr: "pipe",
  });
  client = new Client({ name: "smoke-client", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  fixture?.server.close();
});

function textOf(result) {
  return result.content.map((part) => part.text ?? "").join("\n");
}

test("server advertises all tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "download_images",
    "export_to_file",
    "extract_leads",
    "extract_list",
    "list_datasets",
    "scrape_page",
  ]);

  const scrapePage = tools.find((tool) => tool.name === "scrape_page");
  assert.equal(scrapePage.inputSchema.type, "object");
  assert.ok(scrapePage.inputSchema.properties.url, "url must be exposed in the JSON schema");
  assert.deepEqual(scrapePage.inputSchema.required, ["url"]);
});

test("scrape_page returns page text", async () => {
  const result = await client.callTool({ name: "scrape_page", arguments: { url: `${baseUrl}/iletisim` } });
  const text = textOf(result);
  assert.ok(!result.isError, text);
  assert.match(text, /Test Ltd|İletişim/);
  assert.match(text, /info@test-firma\.com/);
  assert.match(text, /dataset_id: ds_\d+/);
});

test("extract_leads reports e-mails and phones", async () => {
  const result = await client.callTool({
    name: "extract_leads",
    arguments: { url: `${baseUrl}/iletisim`, max_pages: 1 },
  });
  const text = textOf(result);
  assert.ok(!result.isError, text);
  assert.match(text, /info@test-firma\.com/);
  assert.match(text, /\+902121234567/);
  assert.match(text, /linkedin/);
});

test("extract_list then export_to_file round-trips a dataset to CSV", async () => {
  const listResult = await client.callTool({
    name: "extract_list",
    arguments: { url: `${baseUrl}/urunler?page=1`, max_pages: 2, item_selector: ".product-card" },
  });
  const listText = textOf(listResult);
  assert.ok(!listResult.isError, listText);
  assert.match(listText, /Extracted 12 items/);

  const datasetId = listText.match(/dataset_id: (ds_\d+)/)?.[1];
  assert.ok(datasetId, "extract_list must return a dataset_id");

  const exportResult = await client.callTool({
    name: "export_to_file",
    arguments: { dataset_id: datasetId, file_path: "urunler.csv" },
  });
  const exportText = textOf(exportResult);
  assert.ok(!exportResult.isError, exportText);
  assert.match(exportText, /Rows: 12/);

  const csvPath = path.join(outputDir, "urunler.csv");
  const csv = await readFile(csvPath, "utf8");
  assert.match(csv, /title,price,priceValue,currency,link,image,text/);
  assert.match(csv, /Ürün 7/, "second page rows must be present");
});

test("download_images writes files under the configured output dir", async () => {
  const result = await client.callTool({
    name: "download_images",
    arguments: { url: `${baseUrl}/galeri`, output_folder: "galeri", min_width: 100, min_height: 100 },
  });
  const text = textOf(result);
  assert.ok(!result.isError, text);
  assert.match(text, /Downloaded 2 of \d+ images/);
  assert.ok(text.includes(path.join(outputDir, "galeri")));
});

test("list_datasets shows the session's datasets", async () => {
  const result = await client.callTool({ name: "list_datasets", arguments: {} });
  const text = textOf(result);
  assert.match(text, /dataset\(s\) in memory/);
  assert.match(text, /extract_list/);
});

test("a failing scrape returns an error message instead of crashing the server", async () => {
  const result = await client.callTool({
    name: "extract_list",
    arguments: { url: `${baseUrl}/tablo`, item_selector: ".does-not-exist" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /matched no usable items/);

  // The server must still be alive and serving requests.
  const followUp = await client.callTool({ name: "list_datasets", arguments: {} });
  assert.ok(!followUp.isError);
});

test("invalid URLs are rejected with a helpful message", async () => {
  const result = await client.callTool({ name: "scrape_page", arguments: { url: "ftp://example.com/file" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Only http\/https URLs are supported/);
});
