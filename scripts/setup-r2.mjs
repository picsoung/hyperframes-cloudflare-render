// One-time bootstrap for the cloud render setup.
//
// Idempotent: running this multiple times is safe. Skips R2 objects that are
// already present, swallows "bucket already exists", surfaces every step's
// outcome so you know what's left to do (which is just the manual public-
// access toggle in the dashboard).
//
// Usage:
//   cd cloudflare-render
//   npm run setup

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadProject, projectRoot } from "./lib/project.mjs";

// Derive identity from the parent HyperFrames project + persist
// .cloudrender.json on first run. Regenerate wrangler.jsonc before any
// wrangler r2 call so bucket names line up.
const project = loadProject();

const ROOT = projectRoot();
const PARENT = project.parentDir;
const VIDEOS_DIR = resolve(PARENT, "assets/videos");
const AUDIO_DIR = resolve(PARENT, "assets/audio");
const BUCKET = project.assetsBucket;
const RENDERS_BUCKET = project.rendersBucket;
const ENV_PATH = resolve(ROOT, ".env");

// Auto-expire to keep R2 storage minimal. Renders are short-lived (download
// or re-run), assets get a longer buffer since re-running setup re-uploads
// raw bytes which isn't free in time. Tune via the constants below.
const ASSETS_EXPIRE_DAYS = 14;
const RENDERS_EXPIRE_DAYS = 7;
const ASSETS_LIFECYCLE_RULE = "auto-expire-assets";
const RENDERS_LIFECYCLE_RULE = "auto-expire-renders";

function run(cmd, args, { ignoreErrors = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0 && !ignoreErrors) {
    process.stderr.write(r.stderr || r.stdout || "");
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function header(label) {
  console.log(`\n=== ${label} ===`);
}

function step(label, ok = true) {
  console.log(`  ${ok ? "✓" : "·"} ${label}`);
}

// ---------- 0. Generate wrangler.jsonc from template ----------

header(`Project: ${project.projectId}`);
step(`worker name → ${project.workerName}`);
step(`assets bucket → ${project.assetsBucket}`);
step(`renders bucket → ${project.rendersBucket}`);

run("node", [resolve(ROOT, "scripts/ensure-wrangler-config.mjs")]);

// ---------- 1. wrangler login check ----------

header("Checking wrangler auth");
const who = run("npx", ["wrangler", "whoami"], { ignoreErrors: true });
if (who.code !== 0 || /You are not logged in/i.test(who.stdout)) {
  console.error("Not logged in. Run `npx wrangler login` first.");
  process.exit(1);
}
const email = who.stdout.match(/email\s+(\S+)/)?.[1] ?? "(unknown)";
step(`logged in as ${email}`);

// ---------- 2. R2 bucket ----------

header(`Ensuring R2 bucket ${BUCKET}`);
const create = run("npx", ["wrangler", "r2", "bucket", "create", BUCKET], { ignoreErrors: true });
if (create.code === 0) {
  step(`bucket created`);
} else if (/already exists/i.test(create.stderr + create.stdout)) {
  step(`bucket already exists`);
} else {
  process.stderr.write(create.stderr || create.stdout);
  process.exit(1);
}

// ---------- 3. Upload assets idempotently ----------

function listExistingKeys(prefix) {
  const r = run("npx", ["wrangler", "r2", "object", "list", BUCKET, "--prefix", prefix], {
    ignoreErrors: true,
  });
  if (r.code !== 0) return new Set();
  const keys = new Set();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\S+?\.\w+)\b/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function uploadIfMissing(localPath, key, contentType, existingKeys) {
  if (existingKeys.has(key)) {
    step(`${key} already uploaded`);
    return false;
  }
  run("npx", [
    "wrangler",
    "r2",
    "object",
    "put",
    `${BUCKET}/${key}`,
    "--file",
    localPath,
    "--content-type",
    contentType,
  ]);
  step(`uploaded ${key}`);
  return true;
}

header(`Uploading missing assets to ${BUCKET}`);

const videoFiles = existsSync(VIDEOS_DIR)
  ? readdirSync(VIDEOS_DIR).filter((f) => /\.(mp4|mov|webm)$/i.test(f))
  : [];
const audioFiles = existsSync(AUDIO_DIR)
  ? readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f))
  : [];

if (videoFiles.length === 0 && audioFiles.length === 0) {
  console.log(
    `  · no heavy assets found under ${PARENT}/assets/{videos,audio}. Skipping uploads.\n` +
      `    (This is fine — if your composition has no video/audio, sync will still work.)`,
  );
} else {
  const existingVideos = listExistingKeys("videos/");
  const existingAudio = listExistingKeys("audio/");

  let uploaded = 0;
  for (const f of videoFiles) {
    if (uploadIfMissing(resolve(VIDEOS_DIR, f), `videos/${f}`, "video/mp4", existingVideos)) {
      uploaded += 1;
    }
  }
  for (const f of audioFiles) {
    const ct =
      /\.mp3$/i.test(f) ? "audio/mpeg"
      : /\.m4a$/i.test(f) ? "audio/mp4"
      : /\.wav$/i.test(f) ? "audio/wav"
      : "application/octet-stream";
    if (uploadIfMissing(resolve(AUDIO_DIR, f), `audio/${f}`, ct, existingAudio)) {
      uploaded += 1;
    }
  }
  step(
    `done — ${uploaded} new upload${uploaded === 1 ? "" : "s"}, ${videoFiles.length + audioFiles.length - uploaded} already present`,
  );
}

// ---------- 4. Lifecycle rules ----------

function ensureLifecycleRule(bucket, ruleName, expireDays) {
  const list = run("npx", ["wrangler", "r2", "bucket", "lifecycle", "list", bucket], {
    ignoreErrors: true,
  });
  if ((list.stdout + list.stderr).includes(ruleName)) {
    step(`${bucket}: lifecycle "${ruleName}" already present (expire ${expireDays}d)`);
    return;
  }
  const r = run(
    "npx",
    [
      "wrangler",
      "r2",
      "bucket",
      "lifecycle",
      "add",
      bucket,
      ruleName,
      "", // empty prefix = applies to all objects
      "--expire-days",
      String(expireDays),
      "--force",
    ],
    { ignoreErrors: true },
  );
  if (r.code === 0) {
    step(`${bucket}: added lifecycle "${ruleName}" → expire after ${expireDays}d`);
  } else {
    console.error(`  ✗ ${bucket}: failed to add lifecycle rule`);
    process.stderr.write(r.stderr || r.stdout);
  }
}

header("Configuring lifecycle rules (auto-expire to bound storage cost)");
ensureLifecycleRule(BUCKET, ASSETS_LIFECYCLE_RULE, ASSETS_EXPIRE_DAYS);
// The renders bucket is auto-created by the template's first deploy. If it
// doesn't exist yet, the lifecycle add will error harmlessly — `npm run
// deploy` first, then re-run setup.
ensureLifecycleRule(RENDERS_BUCKET, RENDERS_LIFECYCLE_RULE, RENDERS_EXPIRE_DAYS);

// ---------- 5. R2 public-access reminder + verify ----------

header("R2 public access");

let r2Base = process.env.R2_ASSETS_BASE;
if (!r2Base && existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^R2_ASSETS_BASE\s*=\s*(.+?)\s*$/);
    if (m) {
      r2Base = m[1].replace(/^["']|["']$/g, "");
      break;
    }
  }
}

if (!r2Base) {
  console.log(`
  → R2_ASSETS_BASE is not set. To finish setup:

      1. Open the Cloudflare dashboard:
         https://dash.cloudflare.com/?to=/:account/r2/buckets/${BUCKET}/settings
      2. Under "R2.dev subdomain" click Allow Access.
      3. Copy the resulting URL (looks like https://pub-<hash>.r2.dev).
      4. Save it to cloudflare-render/.env:

           R2_ASSETS_BASE=https://pub-<hash>.r2.dev

      5. Re-run \`npm run setup\` — it'll verify the URL works.
      6. Then \`npm run deploy\` and \`npm run render:cloud\`.
`);
  process.exit(0);
}

step(`R2_ASSETS_BASE = ${r2Base}`);

// Verify the URL serves a known asset (if there is one)
const audioProbe = audioFiles[0] ? `audio/${audioFiles[0]}` : null;
const videoProbe = videoFiles[0] ? `videos/${videoFiles[0]}` : null;
const probeKey = audioProbe ?? videoProbe;
if (probeKey) {
  const probeUrl = `${r2Base.replace(/\/+$/, "")}/${probeKey}`;
  const probe = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-I", probeUrl]);
  if (probe.stdout.trim() === "200") {
    step(`public URL works (${probeUrl} → HTTP 200)`);
  } else {
    console.error(`\n  ✗ Probe failed for ${probeUrl} → HTTP ${probe.stdout.trim()}`);
    console.error(
      `    Public access may still be disabled. Toggle "R2.dev subdomain → Allow Access" in the dashboard.`,
    );
    process.exit(1);
  }
} else {
  step(`(no heavy assets to probe — skipping URL verification)`);
}

header("Setup complete");
console.log(`
  Next:
    npm run deploy           # builds + deploys the Worker and container
    npm run render:cloud     # fires a render and saves the MP4 locally
`);
