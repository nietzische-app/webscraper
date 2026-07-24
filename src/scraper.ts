/**
 * Universal Web Scraper — Playwright engine.
 *
 * Holds the browser lifecycle (one shared Chromium instance, one fresh context
 * per job) and the four extraction primitives used by the MCP tools:
 *   - scrapePageText
 *   - extractLeads
 *   - extractStructuredList
 *   - downloadImages
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Browser lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/** Used only if the real Chromium build number cannot be read. */
const FALLBACK_CHROME_VERSION = "140.0.0.0";

/** Close the shared browser after this much inactivity so idle servers stay cheap. */
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_NAV_TIMEOUT_MS = 45_000;

function platformToken(): string {
  switch (process.platform) {
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    default:
      return "X11; Linux x86_64";
  }
}

export interface NavigationOptions {
  /** Extra idle wait after load, for JS-rendered content. */
  waitMs?: number;
  /** Block until this selector appears (CSS). */
  waitForSelector?: string;
  /** Scroll to the bottom to trigger lazy-loaded content. */
  scrollToBottom?: boolean;
  /** Skip images/fonts/media downloads — much faster for text-only jobs. */
  blockAssets?: boolean;
  /** Navigation timeout in milliseconds. */
  timeoutMs?: number;
  /** Viewport width/height for responsive pages. */
  viewport?: { width: number; height: number };
  /** Run with a visible browser window (debugging). */
  headful?: boolean;
  /** Locale sent as Accept-Language, e.g. "tr-TR". */
  locale?: string;
}

/**
 * Owns a single Chromium process shared by every job. Contexts are created and
 * disposed per job so cookies, storage and route handlers never leak across
 * unrelated sites.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeJobs = 0;
  private headfulMode = false;

  async getBrowser(headful = false): Promise<Browser> {
    // A headful request while a headless browser is up (or vice versa) needs a relaunch.
    if (this.browser && this.browser.isConnected() && this.headfulMode !== headful) {
      await this.close();
    }
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.headfulMode = headful;
    // Lets users point at an existing Chrome/Chromium instead of Playwright's
    // own download (SCRAPER_CHROME_PATH), or use a stable channel by name.
    const executablePath = process.env.SCRAPER_CHROME_PATH?.trim();
    const channel = process.env.SCRAPER_BROWSER_CHANNEL?.trim();
    const proxyServer = process.env.SCRAPER_PROXY?.trim();
    const proxy = proxyServer
      ? {
          server: proxyServer,
          ...(process.env.SCRAPER_PROXY_USERNAME ? { username: process.env.SCRAPER_PROXY_USERNAME } : {}),
          ...(process.env.SCRAPER_PROXY_PASSWORD ? { password: process.env.SCRAPER_PROXY_PASSWORD } : {}),
        }
      : undefined;

    this.launching = chromium
      .launch({
        headless: !headful,
        ...(executablePath ? { executablePath } : {}),
        ...(channel && !executablePath ? { channel } : {}),
        ...(proxy ? { proxy } : {}),
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-gpu",
          "--lang=en-US",
        ],
      })
      .then((browser) => {
        this.browser = browser;
        this.launching = null;
        browser.on("disconnected", () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      })
      .catch((err) => {
        this.launching = null;
        const message = err instanceof Error ? err.message : String(err);

        // "libnspr4.so: cannot open shared object file" means the browser IS
        // downloaded but the OS is missing the libraries it links against —
        // a different fix from "the browser was never downloaded".
        if (/cannot open shared object file|error while loading shared libraries/.test(message)) {
          const missing = message.match(/([\w.+-]+\.so[\w.]*): cannot open shared object file/)?.[1];
          throw new Error(
            `Chromium is installed but the system is missing the libraries it needs${missing ? ` (first one: ${missing})` : ""}. ` +
              'Install them once with "sudo npx playwright install-deps chromium" ' +
              '(preview what apt would install first with "npx playwright install-deps --dry-run chromium"), ' +
              "or run the app via Docker, which ships them. Original error: " +
              message,
          );
        }

        throw new Error(
          'Chromium could not be launched. Run "npx playwright install chromium" once, or set ' +
            "SCRAPER_CHROME_PATH to an existing Chrome binary. Original error: " +
            message,
        );
      });

    return this.launching;
  }

  /**
   * Builds a Chrome UA string from the *actual* Chromium build in use, so the
   * UA, the Client Hints headers and the real engine behaviour stay consistent
   * (mismatches are one of the easiest bot signals to spot).
   */
  private userAgentFor(browser: Browser): { ua: string; major: string } {
    const override = process.env.SCRAPER_USER_AGENT;
    const rawMajor = browser.version().split(".")[0] ?? "";
    const major = /^\d+$/.test(rawMajor) ? rawMajor : FALLBACK_CHROME_VERSION.split(".")[0]!;
    if (override) return { ua: override, major };
    const version = /^\d+$/.test(rawMajor) ? `${rawMajor}.0.0.0` : FALLBACK_CHROME_VERSION;
    return {
      ua: `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      major,
    };
  }

  async createContext(options: NavigationOptions = {}): Promise<BrowserContext> {
    const browser = await this.getBrowser(options.headful ?? false);
    const { ua, major } = this.userAgentFor(browser);
    const locale = options.locale ?? process.env.SCRAPER_LOCALE ?? "en-US";

    const context = await browser.newContext({
      userAgent: ua,
      locale,
      timezoneId: process.env.SCRAPER_TIMEZONE ?? "Europe/Istanbul",
      viewport: options.viewport ?? { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        "Accept-Language": `${locale},en;q=0.9`,
        "Accept-Encoding": "gzip, deflate, br",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "sec-ch-ua": `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": `"${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"}"`,
      },
    });

    context.setDefaultTimeout(options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS);

    // Hide the most obvious headless/automation fingerprints.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // Real Chrome exposes window.chrome; headless Chromium does not.
      const w = window as unknown as Record<string, unknown>;
      if (!w.chrome) w.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = ((parameters: PermissionDescriptor) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters)) as typeof window.navigator.permissions.query;
    });

    if (options.blockAssets) {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") return route.abort();
        return route.continue();
      });
    }

    return context;
  }

  /** Runs `fn` with a ready page, then disposes the page and its context. */
  async withPage<T>(options: NavigationOptions, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    this.activeJobs += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    let context: BrowserContext | null = null;
    try {
      context = await this.createContext(options);
      const page = await context.newPage();
      return await fn(page, context);
    } finally {
      if (context) await context.close().catch(() => undefined);
      this.activeJobs -= 1;
      this.scheduleIdleShutdown();
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.activeJobs > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeJobs === 0) void this.close();
    }, BROWSER_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => undefined);
  }
}

export const browserManager = new BrowserManager();

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  // Only add a scheme when there is none — "ftp://x" must fail the check below,
  // not become "https://ftp://x".
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: "${input}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs are supported, got "${parsed.protocol}"`);
  }
  return parsed.toString();
}

function absoluteUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value || value.startsWith("javascript:") || value === "#") return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strips non-content nodes and returns readable page text. */
function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template, link, meta").remove();
  $("br").replaceWith("\n");
  $("p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n");
  });
  return collapseWhitespace($("body").text() || $.root().text());
}

async function autoScroll(page: Page, maxSteps = 40): Promise<void> {
  await page.evaluate(async (steps) => {
    await new Promise<void>((resolve) => {
      let previousHeight = 0;
      let stableRounds = 0;
      let iterations = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, window.innerHeight);
        const height = document.body.scrollHeight;
        iterations += 1;
        stableRounds = height === previousHeight ? stableRounds + 1 : 0;
        previousHeight = height;
        if (stableRounds >= 3 || iterations >= steps) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  }, maxSteps);
}

/** Navigate + apply the common "wait for content" options. */
async function gotoAndSettle(page: Page, url: string, options: NavigationOptions): Promise<number | null> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS,
  });

  // Best-effort: many sites keep long-polling connections open forever.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

  if (options.waitForSelector) {
    await page.waitForSelector(options.waitForSelector, {
      timeout: options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS,
    });
  }
  if (options.scrollToBottom) {
    await autoScroll(page).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  }
  if (options.waitMs && options.waitMs > 0) {
    await page.waitForTimeout(Math.min(options.waitMs, 30_000));
  }

  return response?.status() ?? null;
}

/* -------------------------------------------------------------------------- */
/* 1. Page text scraping                                                      */
/* -------------------------------------------------------------------------- */

export interface PageLink {
  text: string;
  url: string;
}

export interface ScrapedPage {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  description: string;
  text: string;
  textLength: number;
  html: string;
  htmlLength: number;
  headings: { level: number; text: string }[];
  links: PageLink[];
  scrapedAt: string;
}

export interface ScrapePageOptions extends NavigationOptions {
  /** Restrict extraction to a subtree (e.g. "main", "#content"). */
  selector?: string;
  /** Keep the raw HTML in the result (large; off by default). */
  includeHtml?: boolean;
  /** Collect anchors from the page. */
  includeLinks?: boolean;
}

export async function scrapePageText(url: string, options: ScrapePageOptions = {}): Promise<ScrapedPage> {
  const target = normalizeUrl(url);

  return browserManager.withPage({ blockAssets: true, ...options }, async (page) => {
    const status = await gotoAndSettle(page, target, options);
    const finalUrl = page.url();
    const fullHtml = await page.content();

    let scopedHtml = fullHtml;
    if (options.selector) {
      const $full = cheerio.load(fullHtml);
      const scoped = $full(options.selector);
      if (scoped.length === 0) {
        throw new Error(`Selector "${options.selector}" matched no elements on ${finalUrl}`);
      }
      scopedHtml = scoped
        .map((_, el) => $full.html(el) ?? "")
        .get()
        .join("\n");
    }

    const $ = cheerio.load(fullHtml);
    const title = ($("title").first().text() || "").trim();
    const description = (
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      ""
    ).trim();

    const headings = $("h1, h2, h3")
      .map((_, el) => {
        const text = collapseWhitespace($(el).text());
        const level = Number(el.tagName.replace(/\D/g, "")) || 1;
        return text ? { level, text } : null;
      })
      .get()
      .filter((h): h is { level: number; text: string } => h !== null)
      .slice(0, 200);

    const links: PageLink[] = [];
    if (options.includeLinks !== false) {
      const seen = new Set<string>();
      $("a[href]").each((_, el) => {
        const abs = absoluteUrl($(el).attr("href"), finalUrl);
        if (!abs || seen.has(abs)) return;
        seen.add(abs);
        links.push({ text: collapseWhitespace($(el).text()).slice(0, 200), url: abs });
      });
    }

    const text = htmlToText(scopedHtml);

    return {
      url: target,
      finalUrl,
      status,
      title,
      description,
      text,
      textLength: text.length,
      html: options.includeHtml ? scopedHtml : "",
      htmlLength: scopedHtml.length,
      headings,
      links: links.slice(0, 1000),
      scrapedAt: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Lead extraction (emails / phones / socials)                             */
/* -------------------------------------------------------------------------- */

const EMAIL_REGEX = /[a-zA-Z0-9._%+'-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,24}/g;

/**
 * Deliberately permissive; every hit is re-validated by `normalizePhone`,
 * which is where the real filtering happens.
 */
const PHONE_REGEX =
  /(?:\+|00)?\d{1,4}?[\s.\-]?\(?\d{2,4}\)?(?:[\s.\-]?\d{2,4}){2,4}/g;

const IMAGE_LIKE_EMAIL = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js)$/i;

const JUNK_EMAIL_DOMAINS = [
  "example.com",
  "example.org",
  "domain.com",
  "yourdomain.com",
  "email.com",
  "sentry.io",
  "sentry-next.wixpress.com",
  "wix.com",
  "schema.org",
  "w3.org",
  "godaddy.com",
];

const SOCIAL_PATTERNS: { network: string; pattern: RegExp }[] = [
  { network: "facebook", pattern: /^https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[^/?#]+/i },
  { network: "instagram", pattern: /^https?:\/\/(?:www\.)?instagram\.com\/[^/?#]+/i },
  { network: "x", pattern: /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/?#]+/i },
  { network: "linkedin", pattern: /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[^/?#]+/i },
  { network: "youtube", pattern: /^https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[^/?#]+/i },
  { network: "tiktok", pattern: /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/?#]+/i },
  { network: "whatsapp", pattern: /^https?:\/\/(?:api\.whatsapp\.com|wa\.me)\/[^\s"']+/i },
  { network: "telegram", pattern: /^https?:\/\/(?:t\.me|telegram\.me)\/[^/?#]+/i },
];

/** Pages worth following when hunting for contact details. */
const CONTACT_LINK_HINT =
  /(contact|kontakt|iletisim|iletişim|about|hakkim|hakkında|impressum|imprint|support|destek|reach-us|team|ekibimiz)/i;

/** Turns "info [at] site [dot] com" style obfuscation back into a real address. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({<]\s*(?:at|@|ät)\s*[\])}>]\s*/gi, "@")
    .replace(/\s+(?:at)\s+(?=[a-z0-9-]+\s*(?:\.|\[dot\]|\(dot\))\s*[a-z]{2,})/gi, "@")
    .replace(/\s*[[({<]\s*(?:dot|punkt|nokta)\s*[\])}>]\s*/gi, ".")
    .replace(/\s+(?:dot|nokta)\s+/gi, ".");
}

function cleanEmail(raw: string): string | null {
  const email = raw.trim().replace(/^[.'-]+/, "").replace(/[.'-]+$/, "").toLowerCase();
  if (!email.includes("@")) return null;
  if (email.length > 254) return null;
  if (IMAGE_LIKE_EMAIL.test(email)) return null;
  // "logo@2x.png" style asset names and version strings.
  if (/@\d+(?:\.\d+)*x?$/.test(email)) return null;
  const domain = email.split("@")[1] ?? "";
  if (!domain.includes(".")) return null;
  if (JUNK_EMAIL_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) return null;
  if (/^[0-9a-f]{16,}@/.test(email)) return null; // hashed/tracking addresses
  return email;
}

const ASCENDING_DIGITS = "01234567890123456789";
const DESCENDING_DIGITS = "98765432109876543210";

export interface PhoneHit {
  raw: string;
  normalized: string;
  source: "tel-link" | "text";
}

/**
 * Reduces a candidate to E.164-ish digits and rejects anything that does not
 * look like a dialable number (dates, prices, IDs, timestamps).
 */
function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null; // 0000000, 1111111...
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])/.test(digits) && digits.length <= 8) return null; // dates
  // Placeholder numbers that are just a digit run (12345678, 987654321).
  if (ASCENDING_DIGITS.includes(digits) || DESCENDING_DIGITS.includes(digits)) return null;
  const separators = (trimmed.match(/[\s.\-()]/g) ?? []).length;
  // A bare 7-9 digit run with no separators and no country code is usually an id.
  if (!hasPlus && separators === 0 && digits.length < 10) return null;
  const normalized = hasPlus ? `+${digits.replace(/^0+/, "")}` : digits;
  return normalized;
}

export interface LeadResult {
  url: string;
  pagesVisited: string[];
  emails: string[];
  phones: PhoneHit[];
  socialProfiles: { network: string; url: string }[];
  addresses: string[];
  contactPagesFollowed: string[];
  scrapedAt: string;
}

export interface ExtractLeadsOptions extends NavigationOptions {
  /** Also visit up to N-1 same-domain contact/about pages (default 1 = only the given URL). */
  maxPages?: number;
}

interface SinglePageLeads {
  emails: Set<string>;
  phones: Map<string, PhoneHit>;
  socials: Map<string, { network: string; url: string }>;
  addresses: Set<string>;
  candidateLinks: string[];
}

function harvestLeadsFromHtml(html: string, pageUrl: string): SinglePageLeads {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const emails = new Set<string>();
  const phones = new Map<string, PhoneHit>();
  const socials = new Map<string, { network: string; url: string }>();
  const addresses = new Set<string>();
  const candidateLinks: string[] = [];

  // 1) Highest-confidence source: explicit mailto:/tel: links.
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (/^mailto:/i.test(href)) {
      const value = decodeURIComponent(href.slice(7).split("?")[0] ?? "");
      for (const part of value.split(/[,;]/)) {
        const email = cleanEmail(part);
        if (email) emails.add(email);
      }
      return;
    }
    if (/^tel:/i.test(href)) {
      const raw = decodeURIComponent(href.slice(4)).trim();
      const normalized = normalizePhone(raw);
      if (normalized) phones.set(normalized, { raw, normalized, source: "tel-link" });
      return;
    }
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    for (const { network, pattern } of SOCIAL_PATTERNS) {
      if (pattern.test(abs) && !socials.has(abs)) {
        socials.set(abs, { network, url: abs });
        break;
      }
    }
    const label = `${$(el).text()} ${href}`;
    if (CONTACT_LINK_HINT.test(label)) candidateLinks.push(abs);
  });

  // 2) Free text (plus a de-obfuscation pass for "info (at) site (dot) com").
  const text = deobfuscate(collapseWhitespace($("body").text() || $.root().text()));

  for (const match of text.matchAll(EMAIL_REGEX)) {
    const email = cleanEmail(match[0]);
    if (email) emails.add(email);
  }
  // Addresses are frequently only present in the raw markup attributes.
  for (const match of html.matchAll(EMAIL_REGEX)) {
    const email = cleanEmail(match[0]);
    if (email) emails.add(email);
  }

  for (const match of text.matchAll(PHONE_REGEX)) {
    const raw = match[0];
    const normalized = normalizePhone(raw);
    if (normalized && !phones.has(normalized)) {
      phones.set(normalized, { raw: raw.trim(), normalized, source: "text" });
    }
  }

  // 3) Postal addresses from schema.org / <address> markup.
  $('address, [itemprop="address"], [itemprop="streetAddress"], .address, .adres').each((_, el) => {
    const value = collapseWhitespace($(el).text());
    if (value.length > 8 && value.length < 300) addresses.add(value);
  });

  return { emails, phones, socials, addresses, candidateLinks };
}

export async function extractLeads(url: string, options: ExtractLeadsOptions = {}): Promise<LeadResult> {
  const target = normalizeUrl(url);
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 1, 10));

  return browserManager.withPage({ blockAssets: true, ...options }, async (page) => {
    const emails = new Set<string>();
    const phones = new Map<string, PhoneHit>();
    const socials = new Map<string, { network: string; url: string }>();
    const addresses = new Set<string>();
    const visited: string[] = [];
    const followed: string[] = [];

    const origin = new URL(target).origin;
    const queue: string[] = [target];
    const seen = new Set<string>([target]);

    while (queue.length > 0 && visited.length < maxPages) {
      const current = queue.shift()!;
      try {
        await gotoAndSettle(page, current, options);
      } catch (err) {
        if (visited.length === 0) throw err; // the first page failing is fatal
        continue; // a secondary contact page failing is not
      }
      const html = await page.content();
      const pageUrl = page.url();
      visited.push(pageUrl);
      if (current !== target) followed.push(pageUrl);

      const harvest = harvestLeadsFromHtml(html, pageUrl);
      for (const email of harvest.emails) emails.add(email);
      for (const [key, value] of harvest.phones) if (!phones.has(key)) phones.set(key, value);
      for (const [key, value] of harvest.socials) if (!socials.has(key)) socials.set(key, value);
      for (const address of harvest.addresses) addresses.add(address);

      if (visited.length < maxPages) {
        for (const candidate of harvest.candidateLinks) {
          if (queue.length + visited.length >= maxPages) break;
          if (seen.has(candidate)) continue;
          if (new URL(candidate).origin !== origin) continue;
          seen.add(candidate);
          queue.push(candidate);
        }
      }
    }

    return {
      url: target,
      pagesVisited: visited,
      emails: [...emails].sort(),
      phones: [...phones.values()].sort((a, b) => a.normalized.localeCompare(b.normalized)),
      socialProfiles: [...socials.values()],
      addresses: [...addresses],
      contactPagesFollowed: followed,
      scrapedAt: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Structured list / table extraction                                      */
/* -------------------------------------------------------------------------- */

const CURRENCY_TOKENS = "₺|TL|TRY|\\$|USD|€|EUR|£|GBP|¥|JPY|CHF|SEK|PLN|RUB|₽|₹|INR";

const PRICE_REGEX = new RegExp(
  `(?:${CURRENCY_TOKENS})\\s?\\d[\\d.,\\s]*\\d|\\d[\\d.,]*\\s?(?:${CURRENCY_TOKENS})`,
  "i",
);

/** Selectors tried, in order, when the caller does not supply one. */
const AUTO_ITEM_SELECTORS = [
  "[data-product-id]",
  "[itemtype*='Product']",
  "li.product",
  ".product-item",
  ".product-card",
  ".product",
  "article.product",
  ".card",
  ".listing-item",
  "[class*='product-list'] > *",
  "[class*='ProductCard']",
  "ul.products > li",
  "table tbody tr",
  "article",
  ".item",
];

const NEXT_PAGE_SELECTORS = [
  "a[rel='next']",
  ".pagination a.next",
  ".pagination .next a",
  "a.next",
  "[aria-label='Next']",
  "[aria-label='Next page']",
  "li.next > a",
];

export interface FieldSpec {
  /** CSS selector relative to the item element. Omit to use the item itself. */
  selector?: string;
  /** Attribute to read (e.g. "href", "src", "data-price"). Omit for text. */
  attr?: string;
  /** Optional regex; the first capture group (or whole match) becomes the value. */
  regex?: string;
}

export interface ExtractListOptions extends NavigationOptions {
  /** CSS selector for one repeated item. Auto-detected when omitted. */
  itemSelector?: string;
  /** Named field extractors. When omitted, a generic product/table shape is used. */
  fields?: Record<string, FieldSpec>;
  /** Max pages to walk through (default 1). */
  maxPages?: number;
  /** CSS selector for the "next page" control. Auto-detected when omitted. */
  nextPageSelector?: string;
  /** URL template containing `{page}` — used instead of clicking a next button. */
  pageUrlPattern?: string;
  /** First page number when using `pageUrlPattern` (default 1). */
  startPage?: number;
  /** Hard cap on returned rows (default 1000). */
  maxItems?: number;
}

export interface ListItem {
  [key: string]: unknown;
}

export interface StructuredListResult {
  url: string;
  itemSelector: string;
  autoDetected: boolean;
  pagesScraped: string[];
  itemCount: number;
  items: ListItem[];
  scrapedAt: string;
}

/** Parses "1.299,90 TL" and "$1,299.90" into a number. */
export function parsePriceValue(raw: string): number | null {
  const match = raw.match(/\d[\d.,\s]*\d|\d/);
  if (!match) return null;
  let digits = match[0].replace(/\s/g, "");
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // The right-most separator is the decimal one.
    if (lastComma > lastDot) digits = digits.replace(/\./g, "").replace(",", ".");
    else digits = digits.replace(/,/g, "");
  } else if (lastComma > -1) {
    // Exactly three digits after the separator means it groups thousands
    // ("1,500"); one or two mean it is decimal ("250,00" → 250).
    const digitsAfter = digits.length - lastComma - 1;
    digits = digitsAfter === 3 ? digits.replace(/,/g, "") : digits.replace(",", ".");
  } else if (lastDot > -1 && digits.length - lastDot - 1 === 3) {
    // Same rule for "1.500" (Turkish thousands); "199.99" stays decimal.
    digits = digits.replace(/\./g, "");
  }
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) ? value : null;
}

function detectCurrency(raw: string): string | null {
  const match = raw.match(new RegExp(CURRENCY_TOKENS, "i"));
  return match ? match[0].toUpperCase().replace("TL", "TRY") : null;
}

/** Picks the largest image from a srcset descriptor list. */
function bestFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, descriptor] = entry.split(/\s+/, 2);
      const width = descriptor?.endsWith("w") ? Number.parseInt(descriptor, 10) : descriptor?.endsWith("x") ? Number.parseFloat(descriptor) * 1000 : 0;
      return { url: url ?? "", width: Number.isFinite(width) ? width : 0 };
    })
    .filter((c) => c.url);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]!.url;
}

/** srcset first: it carries the full-resolution variant, `src` is often a thumbnail. */
const LAZY_IMAGE_ATTRS = ["srcset", "data-srcset", "data-zoom-image", "data-large-image", "src", "data-src", "data-original", "data-lazy-src"];

function imageFromElement($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>, base: string): string | null {
  const img = el.is("img") ? el : el.find("img").first();
  if (img.length > 0) {
    for (const attr of LAZY_IMAGE_ATTRS) {
      const value = img.attr(attr);
      if (!value) continue;
      const candidate = attr.includes("srcset") ? bestFromSrcset(value) : value;
      const abs = absoluteUrl(candidate ?? undefined, base);
      if (abs) return abs;
    }
  }
  const source = el.find("source[srcset]").first().attr("srcset");
  if (source) {
    const abs = absoluteUrl(bestFromSrcset(source) ?? undefined, base);
    if (abs) return abs;
  }
  const style = el.attr("style") ?? el.find("[style*='background']").first().attr("style") ?? "";
  const bg = style.match(/background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/i);
  if (bg?.[2]) return absoluteUrl(bg[2], base);
  return null;
}

function applyFieldSpec(
  $: cheerio.CheerioAPI,
  item: cheerio.Cheerio<any>,
  spec: FieldSpec,
  base: string,
): string | null {
  const node = spec.selector ? item.find(spec.selector).first() : item;
  if (node.length === 0) return null;

  let value: string | null;
  if (spec.attr) {
    value = node.attr(spec.attr) ?? null;
    if (value && (spec.attr === "href" || spec.attr === "src")) value = absoluteUrl(value, base);
  } else {
    value = collapseWhitespace(node.text());
  }
  if (!value) return null;

  if (spec.regex) {
    const match = value.match(new RegExp(spec.regex));
    if (!match) return null;
    value = match[1] ?? match[0];
  }
  return value || null;
}

/** Default shape used when the caller does not describe the fields. */
function genericItemShape($: cheerio.CheerioAPI, item: cheerio.Cheerio<any>, base: string): ListItem {
  const text = collapseWhitespace(item.text());
  const heading = collapseWhitespace(
    item.find("h1, h2, h3, h4, h5, .title, [class*='title'], [class*='name'], a[title]").first().text(),
  );
  const linkEl = item.is("a") ? item : item.find("a[href]").first();
  const link = absoluteUrl(linkEl.attr("href"), base);
  const priceCandidate =
    collapseWhitespace(item.find("[class*='price'], [itemprop='price'], .amount, bdi").first().text()) || text;
  const priceMatch = priceCandidate.match(PRICE_REGEX) ?? text.match(PRICE_REGEX);
  const priceRaw = priceMatch ? collapseWhitespace(priceMatch[0]) : null;
  const image = imageFromElement($, item, base);

  return {
    title: heading || (linkEl.attr("title") ?? "") || text.split("\n")[0]?.slice(0, 200) || "",
    price: priceRaw,
    priceValue: priceRaw ? parsePriceValue(priceRaw) : null,
    currency: priceRaw ? detectCurrency(priceRaw) : null,
    link,
    image,
    text: text.slice(0, 500),
  };
}

/** Table rows get header-keyed columns, which is far more useful than generic text. */
function extractTableRow($: cheerio.CheerioAPI, row: cheerio.Cheerio<any>, base: string): ListItem | null {
  const cells = row.find("td, th");
  if (cells.length === 0) return null;

  const table = row.closest("table");
  const headerCells = table.find("thead tr").first().find("th, td");
  const headers = (headerCells.length > 0 ? headerCells : table.find("tr").first().find("th"))
    .map((_, el) => collapseWhitespace($(el).text()))
    .get();

  const item: ListItem = {};
  cells.each((index, el) => {
    const cell = $(el);
    const key = collapseWhitespace(headers[index] ?? "") || `column_${index + 1}`;
    const value = collapseWhitespace(cell.text());
    item[key] = value;
    const href = absoluteUrl(cell.find("a[href]").first().attr("href"), base);
    if (href) item[`${key}_link`] = href;
  });
  return Object.values(item).some((v) => typeof v === "string" && v.length > 0) ? item : null;
}

function extractItemsFromHtml(
  html: string,
  base: string,
  itemSelector: string,
  fields?: Record<string, FieldSpec>,
): ListItem[] {
  const $ = cheerio.load(html);
  const nodes = $(itemSelector);
  const items: ListItem[] = [];

  nodes.each((_, el) => {
    const item = $(el);
    if (fields && Object.keys(fields).length > 0) {
      const record: ListItem = {};
      let hasValue = false;
      for (const [name, spec] of Object.entries(fields)) {
        const value = applyFieldSpec($, item, spec, base);
        record[name] = value;
        if (value) hasValue = true;
      }
      if (hasValue) items.push(record);
      return;
    }

    if (item.is("tr")) {
      const row = extractTableRow($, item, base);
      if (row) items.push(row);
      return;
    }

    const generic = genericItemShape($, item, base);
    if (String(generic.title ?? "").length > 0 || generic.link || generic.image) items.push(generic);
  });

  return items;
}

/** Scores candidate selectors and returns the one that looks most like a real list. */
function autoDetectItemSelector(html: string): string | null {
  const $ = cheerio.load(html);
  let best: { selector: string; score: number } | null = null;

  for (const selector of AUTO_ITEM_SELECTORS) {
    let nodes;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }
    const count = nodes.length;
    if (count < 3) continue;

    // Prefer repeated blocks that actually carry content (link or image or price).
    let meaningful = 0;
    nodes.slice(0, 40).each((_, el) => {
      const item = $(el);
      const text = collapseWhitespace(item.text());
      if (text.length < 3) return;
      if (item.find("a[href], img").length > 0 || PRICE_REGEX.test(text) || item.is("tr")) meaningful += 1;
    });
    if (meaningful < 3) continue;

    const sampled = Math.min(count, 40);
    const score = (meaningful / sampled) * Math.log10(count + 1) * 100;
    if (!best || score > best.score) best = { selector, score };
  }

  return best?.selector ?? null;
}

function fingerprint(item: ListItem): string {
  return createHash("sha1").update(JSON.stringify(item)).digest("hex");
}

export async function extractStructuredList(
  url: string,
  options: ExtractListOptions = {},
): Promise<StructuredListResult> {
  const target = normalizeUrl(url);
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 1, 50));
  const maxItems = Math.max(1, Math.min(options.maxItems ?? 1000, 10_000));

  return browserManager.withPage({ blockAssets: true, ...options }, async (page) => {
    const items: ListItem[] = [];
    const seen = new Set<string>();
    const pagesScraped: string[] = [];
    let itemSelector = options.itemSelector ?? "";
    let autoDetected = false;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      if (pageIndex === 0) {
        const firstUrl = options.pageUrlPattern
          ? options.pageUrlPattern.replace("{page}", String(options.startPage ?? 1))
          : target;
        await gotoAndSettle(page, normalizeUrl(firstUrl), options);
      } else if (options.pageUrlPattern) {
        const pageNumber = (options.startPage ?? 1) + pageIndex;
        await gotoAndSettle(page, normalizeUrl(options.pageUrlPattern.replace("{page}", String(pageNumber))), options);
      } else {
        const moved = await clickNextPage(page, options.nextPageSelector);
        if (!moved) break;
        if (options.scrollToBottom) await autoScroll(page).catch(() => undefined);
        if (options.waitForSelector) {
          await page.waitForSelector(options.waitForSelector, { timeout: 15_000 }).catch(() => undefined);
        }
      }

      const html = await page.content();
      pagesScraped.push(page.url());

      if (!itemSelector) {
        const detected = autoDetectItemSelector(html);
        if (!detected) {
          throw new Error(
            "Could not auto-detect a repeating item selector on this page. Pass `item_selector` explicitly " +
              "(e.g. \".product-card\", \"table tbody tr\", \"li.search-result\").",
          );
        }
        itemSelector = detected;
        autoDetected = true;
      }

      const pageItems = extractItemsFromHtml(html, page.url(), itemSelector, options.fields);
      let added = 0;
      for (const item of pageItems) {
        const key = fingerprint(item);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        added += 1;
        if (items.length >= maxItems) break;
      }

      if (items.length >= maxItems) break;
      // No new rows on a fresh page means pagination is looping or exhausted.
      if (pageIndex > 0 && added === 0) break;
    }

    if (items.length === 0) {
      throw new Error(
        `Selector "${itemSelector}" matched no usable items on ${target}. ` +
          "Try a different `item_selector`, or set `wait_for_selector`/`scroll_to_bottom` if the list is rendered lazily.",
      );
    }

    return {
      url: target,
      itemSelector,
      autoDetected,
      pagesScraped,
      itemCount: items.length,
      items,
      scrapedAt: new Date().toISOString(),
    };
  });
}

async function clickNextPage(page: Page, explicitSelector?: string): Promise<boolean> {
  const selectors = explicitSelector ? [explicitSelector] : NEXT_PAGE_SELECTORS;
  const before = page.url();

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const disabled = await locator
      .evaluate((el) => {
        const node = el as HTMLElement;
        return (
          node.hasAttribute("disabled") ||
          node.getAttribute("aria-disabled") === "true" ||
          node.classList.contains("disabled")
        );
      })
      .catch(() => false);
    if (disabled) continue;

    try {
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined),
        locator.click({ timeout: 10_000 }),
      ]);
      // SPA pagination keeps the same URL, so give the DOM a moment to swap.
      await page.waitForTimeout(1_200);
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      return page.url() !== before || true;
    } catch {
      continue;
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* 4. Image downloading                                                       */
/* -------------------------------------------------------------------------- */

export interface DownloadedImage {
  sourceUrl: string;
  filePath: string;
  bytes: number;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface DownloadImagesOptions extends NavigationOptions {
  /** Skip images whose rendered/natural width is below this (default 200). */
  minWidth?: number;
  /** Skip images whose rendered/natural height is below this (default 200). */
  minHeight?: number;
  /** Maximum number of files to write (default 100). */
  maxImages?: number;
  /** Only collect the URLs, do not write any files. */
  listOnly?: boolean;
}

interface ImageCandidate {
  url: string;
  width: number | null;
  height: number | null;
  alt: string;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/tiff": ".tiff",
};

function safeFileName(sourceUrl: string, contentType: string, index: number): string {
  let base = "image";
  try {
    const parsed = new URL(sourceUrl);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last) base = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "");
  } catch {
    /* data: URIs and friends fall back to "image" */
  }
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
  const ext = EXTENSION_BY_MIME[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? ".jpg";
  return `${String(index).padStart(3, "0")}-${base}${ext}`;
}

export async function downloadImages(
  url: string,
  outputFolder: string,
  options: DownloadImagesOptions = {},
): Promise<{
  url: string;
  outputFolder: string;
  found: number;
  downloaded: DownloadedImage[];
  skipped: { url: string; reason: string }[];
  scrapedAt: string;
}> {
  const target = normalizeUrl(url);
  const minWidth = options.minWidth ?? 200;
  const minHeight = options.minHeight ?? 200;
  const maxImages = Math.max(1, Math.min(options.maxImages ?? 100, 1000));
  const destination = path.resolve(outputFolder);

  // Images are the payload here, so never block them.
  return browserManager.withPage({ ...options, blockAssets: false, scrollToBottom: options.scrollToBottom ?? true }, async (page, context) => {
    await gotoAndSettle(page, target, { ...options, blockAssets: false, scrollToBottom: options.scrollToBottom ?? true });
    const pageUrl = page.url();

    const candidates: ImageCandidate[] = await page.evaluate(() => {
      const results: { url: string; width: number | null; height: number | null; alt: string }[] = [];
      const push = (raw: string | null | undefined, width: number | null, height: number | null, alt: string) => {
        if (!raw) return;
        const value = raw.trim();
        if (!value || value.startsWith("blob:")) return;
        try {
          results.push({ url: new URL(value, document.baseURI).toString(), width, height, alt });
        } catch {
          /* ignore malformed URLs */
        }
      };
      const pickSrcset = (srcset: string): string | null => {
        const entries = srcset
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [u, d] = entry.split(/\s+/, 2);
            const w = d?.endsWith("w") ? parseInt(d, 10) : d?.endsWith("x") ? parseFloat(d) * 1000 : 0;
            return { u: u ?? "", w: Number.isFinite(w) ? w : 0 };
          })
          .filter((e) => e.u);
        if (entries.length === 0) return null;
        entries.sort((a, b) => b.w - a.w);
        return entries[0]?.u ?? null;
      };

      for (const img of Array.from(document.querySelectorAll("img"))) {
        const natural = { w: img.naturalWidth || null, h: img.naturalHeight || null };
        const rect = img.getBoundingClientRect();
        const width = natural.w ?? (rect.width ? Math.round(rect.width) : null);
        const height = natural.h ?? (rect.height ? Math.round(rect.height) : null);
        const alt = img.getAttribute("alt") ?? "";
        // Prefer the largest srcset entry over the (often downscaled) src.
        const srcset = img.getAttribute("srcset") ?? img.getAttribute("data-srcset");
        push(srcset ? pickSrcset(srcset) : null, width, height, alt);
        push(img.currentSrc || img.src, width, height, alt);
        for (const attr of ["data-src", "data-original", "data-lazy-src", "data-zoom-image", "data-large-image"]) {
          push(img.getAttribute(attr), width, height, alt);
        }
      }

      for (const source of Array.from(document.querySelectorAll("picture source[srcset]"))) {
        push(pickSrcset(source.getAttribute("srcset") ?? ""), null, null, "");
      }

      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === "none") continue;
        const match = bg.match(/url\((['"]?)(.*?)\1\)/);
        if (match?.[2] && !match[2].startsWith("data:image/svg")) {
          const rect = el.getBoundingClientRect();
          push(match[2], Math.round(rect.width) || null, Math.round(rect.height) || null, "");
        }
      }

      const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
      push(og, null, null, "og:image");

      return results;
    });

    // Dedupe by URL, keeping the largest known dimensions per URL.
    const byUrl = new Map<string, ImageCandidate>();
    for (const candidate of candidates) {
      const existing = byUrl.get(candidate.url);
      if (!existing) {
        byUrl.set(candidate.url, candidate);
        continue;
      }
      existing.width = Math.max(existing.width ?? 0, candidate.width ?? 0) || null;
      existing.height = Math.max(existing.height ?? 0, candidate.height ?? 0) || null;
      if (!existing.alt && candidate.alt) existing.alt = candidate.alt;
    }

    const skipped: { url: string; reason: string }[] = [];
    const eligible: ImageCandidate[] = [];
    for (const candidate of byUrl.values()) {
      const tooSmall =
        (candidate.width !== null && candidate.width < minWidth) ||
        (candidate.height !== null && candidate.height < minHeight);
      if (tooSmall) {
        skipped.push({ url: candidate.url, reason: `below ${minWidth}x${minHeight} (${candidate.width}x${candidate.height})` });
        continue;
      }
      eligible.push(candidate);
    }
    // Biggest first, so a maxImages cap keeps the high-resolution ones.
    eligible.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));

    if (options.listOnly) {
      return {
        url: target,
        outputFolder: destination,
        found: byUrl.size,
        downloaded: eligible.slice(0, maxImages).map((c) => ({
          sourceUrl: c.url,
          filePath: "",
          bytes: 0,
          contentType: "",
          width: c.width,
          height: c.height,
        })),
        skipped,
        scrapedAt: new Date().toISOString(),
      };
    }

    await mkdir(destination, { recursive: true });

    const downloaded: DownloadedImage[] = [];
    const contentHashes = new Set<string>();

    for (const candidate of eligible) {
      if (downloaded.length >= maxImages) break;
      try {
        let buffer: Buffer;
        let contentType: string;

        if (candidate.url.startsWith("data:")) {
          const match = candidate.url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
          if (!match) {
            skipped.push({ url: candidate.url.slice(0, 80), reason: "unparsable data URI" });
            continue;
          }
          contentType = match[1] ?? "image/png";
          buffer = Buffer.from(decodeURIComponent(match[3] ?? ""), match[2] ? "base64" : "utf8");
        } else {
          // Uses the browser context so cookies and the referer match the page.
          const response = await context.request.get(candidate.url, {
            headers: { referer: pageUrl, accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
            timeout: 30_000,
          });
          if (!response.ok()) {
            skipped.push({ url: candidate.url, reason: `HTTP ${response.status()}` });
            continue;
          }
          contentType = response.headers()["content-type"] ?? "";
          if (!contentType.startsWith("image/")) {
            skipped.push({ url: candidate.url, reason: `not an image (${contentType || "unknown"})` });
            continue;
          }
          buffer = await response.body();
        }

        if (buffer.byteLength < 1024) {
          skipped.push({ url: candidate.url, reason: `too small (${buffer.byteLength} bytes)` });
          continue;
        }
        const hash = createHash("sha1").update(buffer).digest("hex");
        if (contentHashes.has(hash)) {
          skipped.push({ url: candidate.url, reason: "duplicate content" });
          continue;
        }
        contentHashes.add(hash);

        const fileName = safeFileName(candidate.url, contentType, downloaded.length + 1);
        const filePath = path.join(destination, fileName);
        await writeFile(filePath, buffer);

        downloaded.push({
          sourceUrl: candidate.url,
          filePath,
          bytes: buffer.byteLength,
          contentType: contentType.split(";")[0] ?? contentType,
          width: candidate.width,
          height: candidate.height,
        });
      } catch (err) {
        skipped.push({ url: candidate.url, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      url: target,
      outputFolder: destination,
      found: byUrl.size,
      downloaded,
      skipped,
      scrapedAt: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 5. Selector discovery                                                      */
/* -------------------------------------------------------------------------- */

export interface SelectorSuggestion {
  selector: string;
  count: number;
  /** Percentage of sampled items carrying each signal. */
  withLink: number;
  withImage: number;
  withPrice: number;
  averageTextLength: number;
  sampleTitles: string[];
  score: number;
}

export interface InspectResult {
  url: string;
  finalUrl: string;
  title: string;
  suggestions: SelectorSuggestion[];
  jsonLdProducts: number;
  totalElements: number;
  hint: string;
  scrapedAt: string;
}

/**
 * Reports which repeated element patterns look like a product/result list, so a
 * failed auto-detection can be turned into an explicit `itemSelector` without
 * opening devtools. Scores candidates by how many of them carry a link, an
 * image and a price, which is what a real listing item almost always has.
 */
export async function suggestItemSelectors(
  url: string,
  options: NavigationOptions = {},
): Promise<InspectResult> {
  const target = normalizeUrl(url);

  return browserManager.withPage({ scrollToBottom: true, ...options }, async (page) => {
    await gotoAndSettle(page, target, { scrollToBottom: true, ...options });

    const analysis = await page.evaluate(() => {
      const PRICE = /(?:₺|TL|TRY|\$|USD|€|EUR|£|GBP)\s?\d|\d[\d.,]*\s?(?:₺|TL|TRY|\$|USD|€|EUR|£|GBP)/i;
      const SKIP_TAGS = new Set(["html", "body", "head", "script", "style", "noscript", "svg", "path", "option"]);

      // 1) Collect class tokens that repeat often enough to be a list.
      const tokenCounts = new Map<string, number>();
      const elements = document.querySelectorAll<HTMLElement>("*");
      for (const el of Array.from(elements)) {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        for (const cls of Array.from(el.classList)) {
          // Skip hashed/utility-looking classes: they rarely identify an item.
          if (!/^[a-zA-Z][\w-]{1,40}$/.test(cls)) continue;
          const key = `${tag}.${cls}`;
          tokenCounts.set(key, (tokenCounts.get(key) ?? 0) + 1);
        }
      }

      // 2) Score every repeated pattern by how "item-like" its elements are.
      const suggestions: {
        selector: string;
        count: number;
        withLink: number;
        withImage: number;
        withPrice: number;
        averageTextLength: number;
        sampleTitles: string[];
        score: number;
      }[] = [];

      for (const [selector, occurrences] of tokenCounts) {
        if (occurrences < 3 || occurrences > 2000) continue;

        let nodes: NodeListOf<HTMLElement>;
        try {
          nodes = document.querySelectorAll<HTMLElement>(selector);
        } catch {
          continue;
        }
        if (nodes.length < 3) continue;

        const sample = Array.from(nodes).slice(0, 40);
        let links = 0;
        let images = 0;
        let prices = 0;
        let totalLength = 0;
        const titles: string[] = [];

        for (const node of sample) {
          const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
          totalLength += text.length;
          if (node.querySelector("a[href]") || node.matches("a[href]")) links += 1;
          if (node.querySelector("img") || /url\(/.test(getComputedStyle(node).backgroundImage)) images += 1;
          if (PRICE.test(text)) prices += 1;
          if (titles.length < 3 && text) titles.push(text.slice(0, 80));
        }

        const sampled = sample.length;
        const linkRatio = links / sampled;
        const imageRatio = images / sampled;
        const priceRatio = prices / sampled;
        const averageTextLength = Math.round(totalLength / sampled);

        // Containers hold everything; single words hold nothing. Aim in between.
        let lengthFactor = 1;
        if (averageTextLength > 800) lengthFactor = 800 / averageTextLength;
        else if (averageTextLength < 15) lengthFactor = Math.max(averageTextLength, 1) / 15;

        const score =
          Math.log10(nodes.length + 1) *
          (0.4 * linkRatio + 0.3 * imageRatio + 0.3 * priceRatio) *
          lengthFactor *
          100;

        if (score <= 0) continue;

        suggestions.push({
          selector,
          count: nodes.length,
          withLink: Math.round(linkRatio * 100),
          withImage: Math.round(imageRatio * 100),
          withPrice: Math.round(priceRatio * 100),
          averageTextLength,
          sampleTitles: titles,
          score: Math.round(score * 10) / 10,
        });
      }

      suggestions.sort((a, b) => b.score - a.score);

      // 3) Structured product data is a useful fallback signal for the caller.
      let jsonLdProducts = 0;
      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        const raw = script.textContent ?? "";
        jsonLdProducts += (raw.match(/"@type"\s*:\s*"Product"/g) ?? []).length;
      }

      return { suggestions: suggestions.slice(0, 12), jsonLdProducts, totalElements: elements.length };
    });

    const best = analysis.suggestions[0];
    let hint: string;
    if (!best) {
      hint =
        "No repeating pattern found. The list is probably rendered after load — retry with " +
        "`waitForSelector` set to something you can see in the page, or a longer `waitMs`. " +
        "A consent/anti-bot wall would also produce this.";
    } else if (best.score < 10) {
      hint =
        `Weak match ("${best.selector}", ${best.count} items). Check the sample texts below; if they are not ` +
        "products, the page likely renders its list with JavaScript after load — add `scrollToBottom: true` " +
        "and a `waitForSelector`.";
    } else {
      hint = `Try itemSelector "${best.selector}" (${best.count} items on this page).`;
    }

    return {
      url: target,
      finalUrl: page.url(),
      title: await page.title(),
      suggestions: analysis.suggestions,
      jsonLdProducts: analysis.jsonLdProducts,
      totalElements: analysis.totalElements,
      hint,
      scrapedAt: new Date().toISOString(),
    };
  });
}
