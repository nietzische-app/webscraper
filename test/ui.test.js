/**
 * Dashboard test: drives public/index.html in a real browser against the
 * compiled API server, so a broken button or renderer fails the suite.
 *
 * Note: cdn.tailwindcss.com is only needed for styling. If it is unreachable
 * the panel still has to work, which is what these assertions check.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { startFixtureServer } from "./fixture-server.js";

let fixture;
let apiServer;
let browser;
let page;
let browserManager;
const pageErrors = [];

before(async () => {
  process.env.SCRAPER_OUTPUT_DIR = await mkdtemp(path.join(tmpdir(), "scraper-ui-"));

  fixture = await startFixtureServer();
  const serverModule = await import("../build/server.js");
  ({ browserManager } = await import("../build/scraper.js"));
  apiServer = await serverModule.startServer(0, "127.0.0.1");

  browser = await chromium.launch({
    ...(process.env.SCRAPER_CHROME_PATH ? { executablePath: process.env.SCRAPER_CHROME_PATH } : {}),
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${apiServer.address().port}`, { waitUntil: "domcontentloaded" });

  // The type radios are visually hidden by Tailwind's `sr-only`, so users click
  // the label card instead. Inject that rule ourselves so the test exercises the
  // same path whether or not the Tailwind CDN was reachable.
  await page.addStyleTag({
    content:
      ".sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}",
  });
});

/** Selects a job type the way a user does: by clicking its card. */
async function selectType(value) {
  await page.locator(`label:has(input[name="type"][value="${value}"])`).click();
  await page.waitForFunction(
    (v) => document.querySelector('input[name="type"]:checked')?.value === v,
    value,
    { timeout: 5_000 },
  );
}

after(async () => {
  await browser?.close();
  await browserManager?.close();
  apiServer?.close();
  fixture?.server.close();
});

test("the panel loads and reports server health", async () => {
  await page.waitForFunction(() => !document.getElementById("health").textContent.includes("bağlanıyor"), null, {
    timeout: 20_000,
  });
  assert.match(await page.locator("#health").textContent(), /çalışıyor/);
});

test("option groups follow the selected job type", async () => {
  await selectType("images");
  assert.ok(await page.locator("#minWidth").isVisible(), "image options must show");
  assert.ok(!(await page.locator("#itemSelector").isVisible()), "list options must hide");

  await selectType("list");
  assert.ok(await page.locator("#itemSelector").isVisible());
  assert.ok(!(await page.locator("#minWidth").isVisible()));
});

test("a list scrape renders a table and exports CSV", async () => {
  await page.fill("#url", `${fixture.baseUrl}/urunler?page=1`);
  await page.fill("#itemSelector", ".product-card");
  await page.fill("#maxPages", "2");
  await page.click("#submitBtn");

  await page.waitForSelector("#results table", { timeout: 60_000 });
  assert.equal(await page.locator("#results tbody tr").count(), 12);
  assert.deepEqual(await page.locator("#results thead th").allTextContents(), [
    "title",
    "price",
    "priceValue",
    "currency",
    "link",
    "image",
    "text",
  ]);

  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "CSV indir" }).click();
  assert.match((await download).suggestedFilename(), /\.csv$/);

  // The generated file also shows up in the sidebar.
  await page.click("#refreshFiles");
  await page.waitForFunction(() => document.querySelectorAll("#fileList a").length > 0, null, { timeout: 10_000 });
});

test("a leads scrape renders e-mails and phones", async () => {
  await selectType("leads");
  await page.fill("#url", `${fixture.baseUrl}/iletisim`);
  await page.click("#submitBtn");

  await page.waitForSelector("#results a[href^='mailto:']", { timeout: 60_000 });
  const emails = await page.locator("#results a[href^='mailto:']").allTextContents();
  assert.ok(emails.includes("info@test-firma.com"), emails.join(","));
  const phones = await page.locator("#results a[href^='tel:']").allTextContents();
  assert.ok(phones.includes("+902121234567"), phones.join(","));
});

test("an image scrape renders working previews", async () => {
  await selectType("images");
  await page.fill("#url", `${fixture.baseUrl}/galeri`);
  await page.fill("#minWidth", "100");
  await page.fill("#minHeight", "100");
  await page.click("#submitBtn");

  await page.waitForSelector("#results img", { timeout: 60_000 });
  assert.equal(await page.locator("#results img").count(), 2);
  const broken = await page
    .locator("#results img")
    .evaluateAll((nodes) => nodes.filter((node) => !node.complete || node.naturalWidth === 0).length);
  assert.equal(broken, 0, "image previews must load through /api/download");
});

test("a failed scrape shows an error box, not a blank panel", async () => {
  await selectType("list");
  await page.fill("#url", `${fixture.baseUrl}/tablo`);
  await page.fill("#itemSelector", ".nope");
  await page.click("#submitBtn");

  await page.waitForSelector("#results .border-red-300", { timeout: 60_000 });
  assert.match(await page.locator("#results").textContent(), /Kazıma başarısız/);
  assert.ok(await page.locator("#submitBtn").isEnabled(), "the button must be usable again");
});

test("recent jobs are listed and no JS exception was thrown", async () => {
  assert.ok((await page.locator("#jobList li").count()) >= 3);
  assert.deepEqual(pageErrors, [], `dashboard threw: ${pageErrors.join(" | ")}`);
});
