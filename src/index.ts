#!/usr/bin/env node
/**
 * Universal Web Scraper — MCP server (stdio transport).
 *
 * Exposes the Playwright scraping engine as MCP tools so Claude Desktop, Cursor
 * or any other MCP client can drive it:
 *   scrape_page | extract_leads | extract_list | download_images | export_to_file
 *
 * IMPORTANT: stdout is the MCP transport. Everything we log goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";

import {
  browserManager,
  downloadImages,
  extractLeads,
  extractStructuredList,
  scrapePageText,
  suggestItemSelectors,
  type FieldSpec,
} from "./scraper.js";
import { defaultOutputDir, exportData, type ExportFormat } from "./exporter.js";

const SERVER_NAME = "universal-web-scraper";
const SERVER_VERSION = "1.0.0";

/* -------------------------------------------------------------------------- */
/* Dataset store                                                              */
/* -------------------------------------------------------------------------- */

interface Dataset {
  id: string;
  tool: string;
  url: string;
  createdAt: string;
  data: unknown;
}

/**
 * Keeps recent results in memory so `export_to_file` can write a full dataset
 * without the model having to echo every row back through the context window.
 */
class DatasetStore {
  private readonly entries = new Map<string, Dataset>();
  private counter = 0;
  constructor(private readonly maxEntries = 50) {}

  save(tool: string, url: string, data: unknown): string {
    this.counter += 1;
    const id = `ds_${this.counter}`;
    this.entries.set(id, { id, tool, url, createdAt: new Date().toISOString(), data });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return id;
  }

  get(id: string): Dataset | undefined {
    return this.entries.get(id);
  }

  list(): Dataset[] {
    return [...this.entries.values()];
  }
}

const datasets = new DatasetStore();

/* -------------------------------------------------------------------------- */
/* Result helpers                                                             */
/* -------------------------------------------------------------------------- */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown, hint?: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = hint ? `\n\n💡 ${hint}` : "";
  return {
    content: [{ type: "text", text: `❌ Scraping failed: ${message}${suffix}` }],
    isError: true,
  };
}

/** Every handler runs through here so a thrown error never kills the server. */
async function runTool(handler: () => Promise<ToolResult>, hint?: string): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    console.error(`[${SERVER_NAME}] tool error:`, error);
    return errorResult(error, hint);
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n…[truncated ${text.length - maxChars} more characters]`, truncated: true };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/* -------------------------------------------------------------------------- */
/* Shared schema fragments                                                    */
/* -------------------------------------------------------------------------- */

const navigationSchema = {
  wait_for_selector: z.string().optional().describe("CSS selector to wait for before extracting (for JS-rendered pages)."),
  wait_ms: z.number().int().min(0).max(30_000).optional().describe("Extra wait in milliseconds after the page loads."),
  scroll_to_bottom: z.boolean().optional().describe("Scroll to the bottom first to trigger lazy-loaded content."),
  timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Navigation timeout in milliseconds (default 45000)."),
  locale: z.string().optional().describe('Browser locale / Accept-Language, e.g. "tr-TR" or "en-US".'),
};

const fieldSpecSchema = z.object({
  selector: z.string().optional().describe("CSS selector relative to the item element. Omit to use the item itself."),
  attr: z.string().optional().describe('Attribute to read, e.g. "href", "src", "data-price". Omit to read text.'),
  regex: z.string().optional().describe("Optional regex; the first capture group (or whole match) becomes the value."),
});

interface NavArgs {
  wait_for_selector?: string;
  wait_ms?: number;
  scroll_to_bottom?: boolean;
  timeout_ms?: number;
  locale?: string;
}

function navOptions(args: NavArgs) {
  return {
    waitForSelector: args.wait_for_selector,
    waitMs: args.wait_ms,
    scrollToBottom: args.scroll_to_bottom,
    timeoutMs: args.timeout_ms,
    locale: args.locale,
  };
}

/* -------------------------------------------------------------------------- */
/* Server + tools                                                             */
/* -------------------------------------------------------------------------- */

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Universal web scraper backed by a real Chromium browser. Use `scrape_page` for readable page content, " +
      "`extract_leads` for e-mail/phone/social contact details, `extract_list` for product grids, listings and tables, " +
      "and `download_images` to save images to disk. Every scraping tool returns a `dataset_id`; pass that id to " +
      "`export_to_file` to write the complete result as CSV or JSON without re-sending the rows.",
  },
);

/* --- 1. scrape_page ------------------------------------------------------- */

server.registerTool(
  "scrape_page",
  {
    title: "Scrape page content",
    description:
      "Load a URL in a real browser and return its readable text, title, meta description, headings and links. " +
      "Use this for articles, documentation, company pages or any general 'what does this page say' question.",
    inputSchema: {
      url: z.string().describe("Page URL to scrape (http/https)."),
      selector: z.string().optional().describe('Limit extraction to a subtree, e.g. "main" or "#content".'),
      include_html: z.boolean().optional().describe("Include the raw HTML in the result (large output)."),
      include_links: z.boolean().optional().describe("Include the page's links (default true)."),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .optional()
        .describe("Max characters of text to return inline (default 15000). The full text stays in the dataset."),
      ...navigationSchema,
    },
  },
  async (args) =>
    runTool(async () => {
      const result = await scrapePageText(args.url, {
        selector: args.selector,
        includeHtml: args.include_html ?? false,
        includeLinks: args.include_links ?? true,
        ...navOptions(args),
      });

      const datasetId = datasets.save("scrape_page", result.finalUrl, result);
      const { text, truncated } = truncate(result.text, args.max_chars ?? 15_000);

      const header = [
        `✅ Scraped: ${result.finalUrl}`,
        `HTTP status: ${result.status ?? "unknown"}`,
        `Title: ${result.title || "(none)"}`,
        result.description ? `Description: ${result.description}` : null,
        `Text length: ${result.textLength} chars${truncated ? " (truncated below)" : ""}`,
        `Links found: ${result.links.length}`,
        `dataset_id: ${datasetId}`,
      ]
        .filter(Boolean)
        .join("\n");

      const sections = [`${header}\n\n--- PAGE TEXT ---\n${text}`];
      if (result.headings.length > 0) {
        sections.push(
          `\n--- HEADINGS ---\n${result.headings
            .slice(0, 50)
            .map((h) => `${"#".repeat(h.level)} ${h.text}`)
            .join("\n")}`,
        );
      }
      if (args.include_html && result.html) {
        const html = truncate(result.html, 20_000);
        sections.push(`\n--- HTML ---\n${html.text}`);
      }

      return textResult(sections.join("\n"));
    }, "Try `wait_for_selector` or `scroll_to_bottom: true` if the page renders its content with JavaScript."),
);

/* --- 2. extract_leads ----------------------------------------------------- */

server.registerTool(
  "extract_leads",
  {
    title: "Extract contact leads",
    description:
      "Collect every e-mail address, phone number, social profile and postal address found on a page. " +
      "Set max_pages > 1 to also follow same-domain contact/about pages. Ideal for lead generation and " +
      "building company contact lists.",
    inputSchema: {
      url: z.string().describe("Page URL to scan for contact details."),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Also follow up to N-1 same-domain contact/about/impressum pages (default 1 = this page only)."),
      ...navigationSchema,
    },
  },
  async (args) =>
    runTool(async () => {
      const result = await extractLeads(args.url, { maxPages: args.max_pages ?? 1, ...navOptions(args) });
      const datasetId = datasets.save("extract_leads", result.url, result);

      const lines = [
        `✅ Lead extraction complete for ${result.url}`,
        `Pages scanned: ${result.pagesVisited.length}${
          result.contactPagesFollowed.length > 0 ? ` (followed: ${result.contactPagesFollowed.join(", ")})` : ""
        }`,
        `dataset_id: ${datasetId}`,
        "",
        `📧 E-mails (${result.emails.length}):`,
        result.emails.length > 0 ? result.emails.map((e) => `  • ${e}`).join("\n") : "  (none found)",
        "",
        `📞 Phones (${result.phones.length}):`,
        result.phones.length > 0
          ? result.phones.map((p) => `  • ${p.normalized}  [raw: ${p.raw}, source: ${p.source}]`).join("\n")
          : "  (none found)",
      ];

      if (result.socialProfiles.length > 0) {
        lines.push("", `🔗 Social profiles (${result.socialProfiles.length}):`);
        lines.push(result.socialProfiles.map((s) => `  • ${s.network}: ${s.url}`).join("\n"));
      }
      if (result.addresses.length > 0) {
        lines.push("", `📍 Addresses (${result.addresses.length}):`);
        lines.push(result.addresses.slice(0, 20).map((a) => `  • ${a}`).join("\n"));
      }
      if (result.emails.length === 0 && result.phones.length === 0) {
        lines.push(
          "",
          "💡 No contact data on this page. Try the site's contact page directly, or re-run with max_pages: 3.",
        );
      }

      return textResult(lines.join("\n"));
    }, "Contact details are often on a dedicated page — re-run with `max_pages: 3` to follow contact/about links."),
);

/* --- 3. extract_list ------------------------------------------------------ */

server.registerTool(
  "extract_list",
  {
    title: "Extract structured list / table",
    description:
      "Extract repeating structured data — product grids with prices and images, search results, directory " +
      "listings or HTML tables — as a JSON array. The item selector is auto-detected when omitted, and " +
      "pagination is supported via a next-page button or a URL pattern.",
    inputSchema: {
      url: z.string().describe("Listing / category / search results URL."),
      item_selector: z
        .string()
        .optional()
        .describe('CSS selector for one repeated item, e.g. ".product-card" or "table tbody tr". Auto-detected if omitted.'),
      fields: z
        .record(z.string(), fieldSpecSchema)
        .optional()
        .describe(
          'Custom field extractors keyed by output column, e.g. {"name": {"selector": ".title"}, "price": {"selector": ".price"}, ' +
            '"link": {"selector": "a", "attr": "href"}}. Omit for automatic title/price/link/image extraction.',
        ),
      max_pages: z.number().int().min(1).max(50).optional().describe("How many pages to walk through (default 1)."),
      next_page_selector: z
        .string()
        .optional()
        .describe('CSS selector for the "next page" control. Auto-detected when omitted.'),
      page_url_pattern: z
        .string()
        .optional()
        .describe('URL template with a {page} placeholder, e.g. "https://site.com/products?page={page}". Used instead of clicking.'),
      start_page: z.number().int().min(0).optional().describe("First page number for page_url_pattern (default 1)."),
      max_items: z.number().int().min(1).max(10_000).optional().describe("Hard cap on returned rows (default 1000)."),
      preview_items: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("How many rows to show inline (default 25). All rows stay in the dataset for export."),
      ...navigationSchema,
    },
  },
  async (args) =>
    runTool(async () => {
      const result = await extractStructuredList(args.url, {
        itemSelector: args.item_selector,
        fields: args.fields as Record<string, FieldSpec> | undefined,
        maxPages: args.max_pages ?? 1,
        nextPageSelector: args.next_page_selector,
        pageUrlPattern: args.page_url_pattern,
        startPage: args.start_page,
        maxItems: args.max_items,
        ...navOptions(args),
      });

      const datasetId = datasets.save("extract_list", result.url, result);
      const previewCount = Math.min(args.preview_items ?? 25, result.items.length);
      const preview = result.items.slice(0, previewCount);

      const header = [
        `✅ Extracted ${result.itemCount} items from ${result.pagesScraped.length} page(s)`,
        `Item selector: "${result.itemSelector}"${result.autoDetected ? " (auto-detected)" : ""}`,
        `Pages: ${result.pagesScraped.join(", ")}`,
        `dataset_id: ${datasetId}`,
        previewCount < result.itemCount ? `Showing the first ${previewCount} of ${result.itemCount} items.` : "",
        "",
        "💾 Call export_to_file with this dataset_id to save every row as CSV or JSON.",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n");

      return textResult(`${header}\n${json(preview)}`);
    }, "If the rows look wrong, pass an explicit `item_selector`, or add `scroll_to_bottom: true` for lazy-loaded grids."),
);

/* --- 4. download_images --------------------------------------------------- */

server.registerTool(
  "download_images",
  {
    title: "Download page images",
    description:
      "Find every image on a page (img, srcset, lazy-loaded attributes, CSS backgrounds, og:image), keep the " +
      "highest-resolution variant of each, and save them to a local folder. Filters out icons and thumbnails by size.",
    inputSchema: {
      url: z.string().describe("Page URL to harvest images from."),
      output_folder: z
        .string()
        .optional()
        .describe(`Destination folder. Relative paths resolve under ${defaultOutputDir()} (default: <output-dir>/images).`),
      min_width: z.number().int().min(0).optional().describe("Skip images narrower than this (default 200 px)."),
      min_height: z.number().int().min(0).optional().describe("Skip images shorter than this (default 200 px)."),
      max_images: z.number().int().min(1).max(1_000).optional().describe("Maximum files to save (default 100, largest first)."),
      list_only: z.boolean().optional().describe("Only list the image URLs, do not write any files."),
      ...navigationSchema,
    },
  },
  async (args) =>
    runTool(async () => {
      const requested = args.output_folder?.trim() || "images";
      const folder = path.isAbsolute(requested) ? requested : path.resolve(defaultOutputDir(), requested);

      const result = await downloadImages(args.url, folder, {
        minWidth: args.min_width,
        minHeight: args.min_height,
        maxImages: args.max_images,
        listOnly: args.list_only ?? false,
        ...navOptions(args),
      });

      const datasetId = datasets.save("download_images", result.url, result);
      const totalBytes = result.downloaded.reduce((sum, image) => sum + image.bytes, 0);

      if (args.list_only) {
        return textResult(
          [
            `✅ Found ${result.found} image URLs on ${result.url} (${result.downloaded.length} pass the size filter).`,
            `dataset_id: ${datasetId}`,
            "",
            result.downloaded.map((image) => `  • ${image.sourceUrl} (${image.width ?? "?"}x${image.height ?? "?"})`).join("\n"),
          ].join("\n"),
        );
      }

      const lines = [
        `✅ Downloaded ${result.downloaded.length} of ${result.found} images found on ${result.url}`,
        `Folder: ${result.outputFolder}`,
        `Total size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
        `dataset_id: ${datasetId}`,
        "",
        result.downloaded
          .slice(0, 50)
          .map(
            (image) =>
              `  • ${path.basename(image.filePath)} — ${image.width ?? "?"}x${image.height ?? "?"}, ${(image.bytes / 1024).toFixed(0)} KB`,
          )
          .join("\n"),
      ];
      if (result.skipped.length > 0) {
        lines.push("", `Skipped ${result.skipped.length} (too small, duplicate or unreachable).`);
      }
      if (result.downloaded.length === 0) {
        lines.push("", "💡 Nothing matched. Lower `min_width`/`min_height`, or set `scroll_to_bottom: true` for lazy galleries.");
      }

      return textResult(lines.join("\n"));
    }, "Lower `min_width`/`min_height` if the page only has small images, or use `list_only: true` to inspect what was found."),
);

/* --- 5. suggest_selectors ------------------------------------------------- */

server.registerTool(
  "suggest_selectors",
  {
    title: "Find the item selector for a listing page",
    description:
      "Inspect a listing page and report which repeating CSS patterns look like product/result items, ranked by " +
      "how many carry a link, an image and a price. Use this when extract_list cannot auto-detect a selector, " +
      "then pass the winning selector back as `item_selector`.",
    inputSchema: {
      url: z.string().describe("Listing / category / search results URL to inspect."),
      ...navigationSchema,
    },
  },
  async (args) =>
    runTool(async () => {
      const result = await suggestItemSelectors(args.url, navOptions(args));
      const datasetId = datasets.save("suggest_selectors", result.finalUrl, result);

      const lines = [
        `🔍 ${result.finalUrl}`,
        `Title: ${result.title || "(none)"}`,
        result.jsonLdProducts > 0 ? `JSON-LD Product entries in the markup: ${result.jsonLdProducts}` : "",
        `dataset_id: ${datasetId}`,
        "",
        `💡 ${result.hint}`,
        "",
      ].filter(Boolean);

      if (result.suggestions.length === 0) {
        lines.push("No repeating pattern scored above zero on this page.");
      } else {
        lines.push("Candidates (best first):", "");
        for (const suggestion of result.suggestions.slice(0, 8)) {
          lines.push(
            `  ${suggestion.selector}  —  ${suggestion.count} items, score ${suggestion.score}`,
            `      link ${suggestion.withLink}% · image ${suggestion.withImage}% · price ${suggestion.withPrice}% · ~${suggestion.averageTextLength} chars`,
            ...suggestion.sampleTitles.map((title) => `      · ${title}`),
            "",
          );
        }
      }

      return textResult(lines.join("\n"));
    }, "If nothing scores well the list is probably rendered after load — retry with `scroll_to_bottom: true` or a `wait_for_selector`."),
);

/* --- 6. export_to_file ---------------------------------------------------- */

server.registerTool(
  "export_to_file",
  {
    title: "Export data to CSV/JSON",
    description:
      "Write scraped data to a local .csv or .json file. Pass the `dataset_id` returned by any scraping tool to " +
      "export the complete result, or pass `data` directly to export your own JSON array/object.",
    inputSchema: {
      file_path: z
        .string()
        .describe(`Output file path. Relative paths resolve under ${defaultOutputDir()}, e.g. "products.csv".`),
      dataset_id: z.string().optional().describe("Id returned by scrape_page / extract_leads / extract_list / download_images."),
      data: z.unknown().optional().describe("Inline data to export (JSON array or object). Ignored when dataset_id is given."),
      format: z.enum(["csv", "json"]).optional().describe("Output format. Inferred from the file extension when omitted."),
    },
  },
  async (args) =>
    runTool(async () => {
      let payload: unknown;
      let origin: string;

      if (args.dataset_id) {
        const dataset = datasets.get(args.dataset_id);
        if (!dataset) {
          const available = datasets.list();
          throw new Error(
            `Unknown dataset_id "${args.dataset_id}". ${
              available.length > 0
                ? `Available: ${available.map((d) => `${d.id} (${d.tool}, ${d.url})`).join("; ")}`
                : "No datasets have been created in this session yet — run a scraping tool first."
            }`,
          );
        }
        payload = dataset.data;
        origin = `dataset ${dataset.id} from ${dataset.tool}`;
      } else if (args.data !== undefined) {
        payload = args.data;
        origin = "inline data";
      } else {
        throw new Error("Provide either `dataset_id` (from a scraping tool) or `data` to export.");
      }

      const result = await exportData(payload, args.file_path, args.format as ExportFormat | undefined);

      return textResult(
        [
          `✅ Exported ${origin} to ${result.format.toUpperCase()}`,
          `File: ${result.filePath}`,
          `Rows: ${result.records}`,
          `Size: ${(result.bytes / 1024).toFixed(1)} KB`,
          result.columns ? `Columns: ${result.columns.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }, "Use an absolute path if you want the file somewhere specific, and a .csv extension for spreadsheet output."),
);

/* --- 7. list_datasets ----------------------------------------------------- */

server.registerTool(
  "list_datasets",
  {
    title: "List scraped datasets",
    description: "Show the datasets captured in this session, with their ids, source tool and URL.",
    inputSchema: {},
  },
  async () =>
    runTool(async () => {
      const all = datasets.list();
      if (all.length === 0) return textResult("No datasets yet. Run scrape_page, extract_leads, extract_list or download_images first.");
      return textResult(
        [`${all.length} dataset(s) in memory:`, ...all.map((d) => `  • ${d.id} — ${d.tool} — ${d.url} — ${d.createdAt}`)].join("\n"),
      );
    }),
);

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await browserManager.close().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio — output dir: ${defaultOutputDir()}`);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (error) => {
  console.error(`[${SERVER_NAME}] uncaught exception:`, error);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[${SERVER_NAME}] unhandled rejection:`, reason);
});

main().catch(async (error) => {
  console.error(`[${SERVER_NAME}] fatal startup error:`, error);
  await shutdown(1);
});
