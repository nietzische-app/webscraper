/**
 * Selector discovery: the loop a user runs when auto-detection fails.
 * The fixture's /magaza page deliberately uses class names outside the
 * built-in candidate list, like a custom-built store.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startFixtureServer } from "./fixture-server.js";
import { browserManager, extractStructuredList, suggestItemSelectors } from "../build/scraper.js";

let fixture;
let baseUrl;

before(async () => {
  fixture = await startFixtureServer();
  baseUrl = fixture.baseUrl;
});

after(async () => {
  await browserManager.close();
  fixture?.server.close();
});

test("auto-detection genuinely fails on this page", async () => {
  await assert.rejects(
    () => extractStructuredList(`${baseUrl}/magaza`),
    /Could not auto-detect a repeating item selector/,
    "the fixture must reproduce the failure this tool exists to solve",
  );
});

test("suggestItemSelectors names the right selector", async () => {
  const result = await suggestItemSelectors(`${baseUrl}/magaza`);

  assert.ok(result.suggestions.length > 0, "expected candidates");
  const best = result.suggestions[0];
  assert.equal(best.selector, "div.urun-kutu-2024", JSON.stringify(result.suggestions.slice(0, 3)));
  assert.equal(best.count, 8);
  assert.equal(best.withLink, 100);
  assert.equal(best.withImage, 100);
  assert.equal(best.withPrice, 100);
  assert.ok(best.sampleTitles[0].includes("Sırt Çantası"), best.sampleTitles.join(" | "));
  assert.match(result.hint, /div\.urun-kutu-2024/);
});

test("it reports structured product data in the markup", async () => {
  const result = await suggestItemSelectors(`${baseUrl}/magaza`);
  assert.equal(result.jsonLdProducts, 1);
  assert.match(result.title, /Sırt Çantası/);
});

test("the suggested selector then extracts the products", async () => {
  const suggestion = await suggestItemSelectors(`${baseUrl}/magaza`);
  const list = await extractStructuredList(`${baseUrl}/magaza`, {
    itemSelector: suggestion.suggestions[0].selector,
  });

  assert.equal(list.itemCount, 8);
  assert.equal(list.items[0].title, "Sırt Çantası Model 1");
  assert.equal(list.items[0].priceValue, 250);
  assert.equal(list.items[0].currency, "TRY");
  assert.match(list.items[0].link, /\/urun\/canta-1$/);
  assert.match(list.items[0].image, /canta-1\.png$/);
});

test("a page with a real product grid still ranks its item class first", async () => {
  const result = await suggestItemSelectors(`${baseUrl}/urunler?page=1`);
  assert.equal(result.suggestions[0].selector, "div.product-card");
  assert.equal(result.suggestions[0].count, 6);
});

test("a page with no list says so instead of inventing one", async () => {
  const result = await suggestItemSelectors(`${baseUrl}/iletisim`);
  assert.match(result.hint, /No repeating pattern|Weak match/);
});

test("prices parse in both Turkish and English formats", async () => {
  const { parsePriceValue } = await import("../build/scraper.js");
  const cases = [
    ["250,00 TL", 250],       // TR decimal comma, the case that was wrong
    ["1.199,90 TL", 1199.9],  // TR thousands + decimal
    ["1.500 TL", 1500],       // TR thousands only
    ["₺89,99", 89.99],
    ["$1,299.00", 1299],      // EN thousands + decimal
    ["$199.99", 199.99],      // EN decimal only
    ["1,500", 1500],          // EN thousands only
    ["€1.234.567,89", 1234567.89],
    ["49 TL", 49],
    ["0,50", 0.5],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parsePriceValue(input), expected, `parsePriceValue(${JSON.stringify(input)})`);
  }
});

test("currency symbols normalise to ISO codes", async () => {
  const { detectCurrency } = await import("../build/scraper.js");
  const cases = [
    ["₺ 2,999.00", "TRY"],   // the symbol paen.com uses
    ["1.499,50 ₺", "TRY"],
    ["250,00 TL", "TRY"],
    ["$199.99", "USD"],
    ["€49,90", "EUR"],
    ["£19.99", "GBP"],
    ["1.299,00 TRY", "TRY"],
    ["no price here", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(detectCurrency(input), expected, `detectCurrency(${JSON.stringify(input)})`);
  }
});
