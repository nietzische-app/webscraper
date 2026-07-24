/**
 * Opens public/index.html straight from disk (file://) — the way someone who
 * downloaded the repo as a zip would — and points it at an API server running
 * elsewhere. Covers the CORS path and the "Sunucu adresi" field.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { startFixtureServer } from "./fixture-server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixture;
let apiServer;
let apiBase;
let browser;
let page;
let browserManager;

before(async () => {
  process.env.SCRAPER_OUTPUT_DIR = await mkdtemp(path.join(tmpdir(), "scraper-standalone-"));

  fixture = await startFixtureServer();
  const serverModule = await import("../build/server.js");
  ({ browserManager } = await import("../build/scraper.js"));
  apiServer = await serverModule.startServer(0, "127.0.0.1");
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;

  browser = await chromium.launch({
    ...(process.env.SCRAPER_CHROME_PATH ? { executablePath: process.env.SCRAPER_CHROME_PATH } : {}),
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  // No web server involved: the browser loads the file itself.
  await page.goto(pathToFileURL(path.join(projectRoot, "public", "index.html")).href);
  await page.addStyleTag({
    content:
      ".sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}",
  });
});

after(async () => {
  await browser?.close();
  await browserManager?.close();
  apiServer?.close();
  fixture?.server.close();
});

test("without a server address it explains what is missing", async () => {
  await page.waitForSelector("#offlineHint", { timeout: 20_000 });
  const hint = await page.locator("#offlineHint").textContent();
  assert.match(hint, /Sunucuya bağlanılamadı/);
  assert.match(hint, /npm run serve/);
  assert.match(hint, /Sunucu adresi/);
});

test("entering a server address connects the file to a remote API", async () => {
  await page.fill("#apiBase", apiBase);
  await page.dispatchEvent("#apiBase", "change");

  await page.waitForFunction(() => document.getElementById("health").textContent.includes("çalışıyor"), null, {
    timeout: 20_000,
  });
  assert.equal(await page.locator("#offlineHint").count(), 0, "the warning must disappear once connected");
});

test("a scrape runs end to end from the local file", async () => {
  await page.fill("#url", `${fixture.baseUrl}/urunler?page=1`);
  await page.fill("#itemSelector", ".product-card");
  await page.click("#submitBtn");

  await page.waitForSelector("#results table", { timeout: 60_000 });
  assert.equal(await page.locator("#results tbody tr").count(), 6);
});

test("image previews load cross-origin through the configured base", async () => {
  await page.locator('label:has(input[name="type"][value="images"])').click();
  await page.fill("#url", `${fixture.baseUrl}/galeri`);
  await page.fill("#minWidth", "100");
  await page.fill("#minHeight", "100");
  await page.click("#submitBtn");

  await page.waitForSelector("#results img", { timeout: 60_000 });
  const sources = await page.locator("#results img").evaluateAll((nodes) => nodes.map((node) => node.src));
  assert.ok(sources.every((src) => src.startsWith(apiBase)), `image sources must be absolute: ${sources.join(", ")}`);
  const broken = await page
    .locator("#results img")
    .evaluateAll((nodes) => nodes.filter((node) => !node.complete || node.naturalWidth === 0).length);
  assert.equal(broken, 0);
});

test("the API sends CORS headers, including for preflight", async () => {
  const response = await fetch(`${apiBase}/api/health`, { headers: { origin: "null" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "*");

  const preflight = await fetch(`${apiBase}/api/scrape`, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "x-api-token" },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-API-Token/i);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
});
