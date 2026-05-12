// One-command cloud render. Hides the two-step /api/render → /r/<key> hop
// and saves the resulting MP4 locally with a timestamped name.
//
// Usage:
//   npm run render:cloud
//   npm run render:cloud -- https://hyperframes-on-cloudflare.<sub>.workers.dev
//
// Worker URL resolution (in order):
//   1. CLI arg
//   2. WORKER_URL env var (or .env in cloudflare-render/)
//   3. `wrangler deployments list` — pulls the most recent deploy URL

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { loadProject } from "./lib/project.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ENV_PATH = resolve(ROOT, ".env");
const RENDERS_DIR = resolve(ROOT, "renders");
const PROJECT = loadProject();

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function resolveWorkerUrl() {
  const cliArg = process.argv[2];
  if (cliArg) return cliArg.replace(/\/+$/, "");

  const env = loadEnv();
  if (env.WORKER_URL) return env.WORKER_URL.replace(/\/+$/, "");
  if (process.env.WORKER_URL) return process.env.WORKER_URL.replace(/\/+$/, "");

  // Fall back to wrangler deployments list for the most recent URL
  const r = spawnSync("npx", ["wrangler", "deployments", "list"], { encoding: "utf8" });
  const m = r.stdout?.match(/https:\/\/[\w.-]+\.workers\.dev/);
  if (m) return m[0];

  console.error(
    "Could not determine the Worker URL. Pass it as the first arg, set WORKER_URL in .env, or deploy first (`npm run deploy`).",
  );
  process.exit(1);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

async function main() {
  const workerUrl = resolveWorkerUrl();
  mkdirSync(RENDERS_DIR, { recursive: true });
  const outPath = resolve(RENDERS_DIR, `${PROJECT.projectId}-${timestamp()}.mp4`);

  console.log(`Worker: ${workerUrl}`);
  console.log(`Output: ${outPath}`);
  console.log(`\nTriggering render — first cold render is ~2–4min, warm renders ~30–60s...\n`);

  const t0 = Date.now();

  // POST /api/render — returns { url: "/r/<key>", ... } or { error: "..." }
  const renderRes = await fetch(`${workerUrl}/api/render`, {
    method: "POST",
    signal: AbortSignal.timeout(30 * 60 * 1000), // 30 min
  });
  const renderText = await renderRes.text();
  let renderJson;
  try {
    renderJson = JSON.parse(renderText);
  } catch {
    console.error(`Render endpoint returned non-JSON (${renderRes.status}):\n${renderText}`);
    process.exit(1);
  }

  if (renderJson.error || !renderRes.ok) {
    console.error(`\n✗ Render failed (${renderRes.status}): ${renderJson.error ?? renderText}`);
    process.exit(1);
  }

  if (!renderJson.url) {
    console.error(`Unexpected response shape:\n${JSON.stringify(renderJson, null, 2)}`);
    process.exit(1);
  }

  const renderMs = Date.now() - t0;
  console.log(`✓ Rendered in ${(renderMs / 1000).toFixed(1)}s. Downloading...`);

  // Download the MP4 from the returned URL. It may be absolute (from the
  // template) or relative ("/r/<key>"); handle both.
  const mp4Url = renderJson.url.startsWith("http")
    ? renderJson.url
    : `${workerUrl}${renderJson.url}`;

  const mp4Res = await fetch(mp4Url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!mp4Res.ok || !mp4Res.body) {
    console.error(`MP4 fetch failed (${mp4Res.status}) from ${mp4Url}`);
    process.exit(1);
  }

  await pipeline(mp4Res.body, createWriteStream(outPath));

  const { size } = statSync(outPath);
  const totalMs = Date.now() - t0;
  console.log(`\n✓ Saved ${fmtBytes(size)} → ${outPath} (total ${(totalMs / 1000).toFixed(1)}s)`);

  if (process.platform === "darwin") {
    spawnSync("open", [outPath]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
