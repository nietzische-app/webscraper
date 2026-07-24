/**
 * Boots `build/server.js` as a real child process with SCRAPER_API_TOKEN set,
 * the way it runs under PM2/Docker, and checks the token gate.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-secret-token";

let child;
let apiBase;

before(async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "scraper-auth-"));

  child = spawn(process.execPath, [path.join(projectRoot, "build", "server.js")], {
    env: {
      ...process.env,
      PORT: "0", // ephemeral: the real port is printed on startup
      HOST: "127.0.0.1",
      SCRAPER_API_TOKEN: TOKEN,
      SCRAPER_OUTPUT_DIR: outputDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  apiBase = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in time")), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const match = chunk.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
});

after(() => {
  child?.kill("SIGTERM");
});

test("health check stays open so monitoring keeps working", async () => {
  const response = await fetch(`${apiBase}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authRequired, true);
});

test("API calls without a token are rejected", async () => {
  const response = await fetch(`${apiBase}/api/jobs`);
  assert.equal(response.status, 401);

  const scrape = await fetch(`${apiBase}/api/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", type: "text" }),
  });
  assert.equal(scrape.status, 401);
});

test("a wrong token is rejected", async () => {
  const response = await fetch(`${apiBase}/api/jobs`, { headers: { "x-api-token": "wrong" } });
  assert.equal(response.status, 401);
});

test("the token is accepted via header, bearer auth and query string", async () => {
  const header = await fetch(`${apiBase}/api/jobs`, { headers: { "x-api-token": TOKEN } });
  assert.equal(header.status, 200);

  const bearer = await fetch(`${apiBase}/api/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200);

  // Query-string form exists so <img src> and plain download links work.
  const query = await fetch(`${apiBase}/api/jobs?token=${TOKEN}`);
  assert.equal(query.status, 200);
});

test("the dashboard itself is served without a token", async () => {
  const response = await fetch(`${apiBase}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Universal Web Scraper/);
});
