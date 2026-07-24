/**
 * End-to-end smoke test. Runs the compiled server (`npm run build` first)
 * against a local fixture site, so it needs no internet access.
 *
 *   npm run build && npm run smoke
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startFixtureServer } from "./fixture-server.js";
import {
  browserManager,
  downloadImages,
  extractLeads,
  extractStructuredList,
  scrapePageText,
} from "../build/scraper.js";
import { exportData, flattenRecord, toRecordArray } from "../build/exporter.js";

let fixture;
let baseUrl;
let workDir;

before(async () => {
  fixture = await startFixtureServer();
  baseUrl = fixture.baseUrl;
  workDir = await mkdtemp(path.join(tmpdir(), "scraper-smoke-"));
});

after(async () => {
  await browserManager.close();
  fixture?.server.close();
});

test("scrapePageText returns title, text and links", async () => {
  const result = await scrapePageText(`${baseUrl}/iletisim`);
  assert.match(result.title, /İletişim/);
  assert.equal(result.status, 200);
  assert.match(result.text, /info@test-firma\.com/);
  assert.ok(result.links.length >= 2, "expected links to be collected");
  assert.ok(result.headings.some((h) => h.text === "İletişim"));
});

test("extractLeads finds e-mails, phones and socials, and follows contact pages", async () => {
  const result = await extractLeads(baseUrl, { maxPages: 3 });

  assert.ok(result.emails.includes("info@test-firma.com"), `emails: ${result.emails}`);
  assert.ok(result.emails.includes("sales@test-firma.com"));
  assert.ok(result.emails.includes("destek@test-firma.com"), "obfuscated '[at]' address should be recovered");
  assert.ok(
    !result.emails.some((email) => email.includes("logo@2x")),
    "image asset names must not be treated as e-mails",
  );

  const phones = result.phones.map((p) => p.normalized);
  assert.ok(phones.includes("+902121234567"), `phones: ${phones}`);
  assert.ok(phones.some((p) => p.endsWith("5329876543")), `phones: ${phones}`);
  assert.ok(!phones.includes("8471294"), "bare order numbers must not be treated as phones");

  const networks = result.socialProfiles.map((s) => s.network).sort();
  assert.deepEqual(networks, ["instagram", "linkedin"]);
  assert.ok(result.addresses.some((a) => a.includes("İstanbul")));
  assert.ok(result.contactPagesFollowed.length >= 1, "should follow the contact page");
});

test("extractStructuredList auto-detects products and paginates", async () => {
  const result = await extractStructuredList(`${baseUrl}/urunler?page=1`, { maxPages: 3 });

  assert.ok(result.autoDetected, "selector should be auto-detected");
  assert.equal(result.itemCount, 18, "3 pages x 6 products");
  assert.equal(result.pagesScraped.length, 3);

  const first = result.items[0];
  assert.equal(first.title, "Ürün 1");
  assert.equal(first.price, "1.199,90 TL");
  assert.equal(first.priceValue, 1199.9);
  assert.equal(first.currency, "TRY");
  assert.match(first.link, /\/urun\/1$/);
  assert.match(first.image, /urun-1-large\.png$/, "should prefer the largest srcset entry");
});

test("extractStructuredList reads HTML tables with header-keyed columns", async () => {
  const result = await extractStructuredList(`${baseUrl}/tablo`, { itemSelector: "table tbody tr" });

  assert.equal(result.itemCount, 3);
  assert.deepEqual(result.items[0], { Model: "A-100", Stok: "12", Fiyat: "$199.99" });
  assert.equal(result.items[2].Fiyat, "$1,299.00");
});

test("extractStructuredList honours custom field specs", async () => {
  const result = await extractStructuredList(`${baseUrl}/urunler?page=1`, {
    itemSelector: ".product-card",
    fields: {
      name: { selector: ".title" },
      price: { selector: ".price" },
      url: { selector: "a", attr: "href" },
    },
  });

  assert.equal(result.itemCount, 6);
  assert.deepEqual(Object.keys(result.items[0]), ["name", "price", "url"]);
  assert.equal(result.items[0].name, "Ürün 1");
  assert.match(result.items[0].url, /^http:\/\/127\.0\.0\.1:\d+\/urun\/1$/);
});

test("downloadImages saves large images and skips icons", async () => {
  const outputFolder = path.join(workDir, "images");
  const result = await downloadImages(`${baseUrl}/galeri`, outputFolder, { minWidth: 100, minHeight: 100 });

  assert.equal(result.downloaded.length, 2, `downloaded: ${JSON.stringify(result.downloaded)}`);
  assert.ok(result.skipped.some((s) => s.url.includes("icon")), "16x16 icon should be filtered out");
  const files = await readdir(outputFolder);
  assert.equal(files.length, 2);
  assert.ok(result.downloaded.every((image) => image.bytes > 1024));
});

test("exportData writes CSV with a union of columns", async () => {
  const list = await extractStructuredList(`${baseUrl}/tablo`, { itemSelector: "table tbody tr" });
  const csvPath = path.join(workDir, "fiyatlar.csv");
  const result = await exportData(list, csvPath, "csv");

  assert.equal(result.records, 3);
  const content = await readFile(result.filePath, "utf8");
  assert.ok(content.startsWith("\uFEFF"), "CSV should carry a UTF-8 BOM for Excel");
  assert.match(content, /Model,Stok,Fiyat/);
  assert.match(content, /A-100,12,\$199\.99/);
  assert.match(content, /"\$1,299\.00"/, "values containing commas must be quoted");
});

test("exportData writes JSON", async () => {
  const jsonPath = path.join(workDir, "sonuc.json");
  const result = await exportData({ hello: "dünya", items: [1, 2, 3] }, jsonPath);
  const parsed = JSON.parse(await readFile(result.filePath, "utf8"));
  assert.equal(parsed.hello, "dünya");
  assert.equal(result.format, "json");
});

test("exporter helpers flatten nested data", () => {
  const flat = flattenRecord({ a: 1, b: { c: "x" }, d: [1, 2], e: null });
  assert.deepEqual(flat, { a: "1", "b.c": "x", d: "1; 2", e: "" });
  assert.deepEqual(toRecordArray({ items: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(toRecordArray("plain"), [{ value: "plain" }]);
});
