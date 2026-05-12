// Sync parent HyperFrames project → public/compositions/<projectId>/,
// rewriting heavy asset references (videos, audio) to R2 public URLs. Run
// before scripts/build.mjs so the bundler picks up the cloud-ready copy.
//
// Source of truth is the parent dir (the HF project this renderer is nested
// inside). Don't edit files inside public/compositions/<projectId>/ — they're
// regenerated every build.

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadProject, projectRoot } from "./lib/project.mjs";

const project = loadProject();
const SRC = project.parentDir;
const DEST = join(projectRoot(), "public", project.compositionDirRel);
const ENV_PATH = join(projectRoot(), ".env");

// Public R2 base URL for the heavy assets bucket. Resolved from env, falling
// back to a local .env file so devs don't need to export it in every shell.
function loadFromEnvFile(key) {
  if (!existsSync(ENV_PATH)) return undefined;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const R2_ASSETS_BASE = process.env.R2_ASSETS_BASE ?? loadFromEnvFile("R2_ASSETS_BASE");
if (!R2_ASSETS_BASE) {
  console.error(
    "[sync-composition] R2_ASSETS_BASE is required.\n" +
      "  → Run `npm run setup` to bootstrap R2 and get the URL.\n" +
      "  → Or paste it directly into cloudflare-render/.env:\n" +
      "      R2_ASSETS_BASE=https://pub-<hash>.r2.dev",
  );
  process.exit(1);
}
const R2_BASE = R2_ASSETS_BASE.replace(/\/+$/, "");

// Files / directories to skip entirely.
const SKIP_DIRS = new Set([
  "node_modules",
  ".thumbnails",
  ".waveform-cache",
  ".wrangler",
  "renders",
  ".git",
  "cloudflare-render",
]);
const SKIP_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "package.json",
  "AGENTS.md",
  "CLAUDE.md",
]);

// Paths under the parent whose contents we never copy (videos/audio live in R2).
const SKIP_PATH_PREFIXES = ["assets/videos/", "assets/audio/"];

async function listFiles(root) {
  const out = [];
  async function walk(rel) {
    const abs = join(root, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(join(rel, e.name));
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name)) continue;
        const relPath = join(rel, e.name).replaceAll("\\", "/");
        if (SKIP_PATH_PREFIXES.some((p) => relPath.startsWith(p))) continue;
        out.push(relPath);
      }
    }
  }
  await walk(".");
  return out.sort();
}

// Rewrite rules — every <video src="..."> and <audio src="..."> reference
// pointing into assets/videos/ or assets/audio/ becomes an absolute R2 URL.
// We match both relative forms (../assets/... from sub-comps in compositions/,
// and assets/... from index.html).
const REWRITES = [
  {
    pattern: /(["'])(?:\.\.\/)?assets\/videos\/([^"']+)\1/g,
    replacement: (_m, q, file) => `${q}${R2_BASE}/videos/${file}${q}`,
  },
  {
    pattern: /(["'])(?:\.\.\/)?assets\/audio\/([^"']+)\1/g,
    replacement: (_m, q, file) => `${q}${R2_BASE}/audio/${file}${q}`,
  },
];

function rewrite(content) {
  let out = content;
  for (const { pattern, replacement } of REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Idempotent file write — skip touching the disk if content matches.
async function writeFileIfChanged(path, content) {
  try {
    const existing = await readFile(path);
    if (Buffer.isBuffer(content) ? existing.equals(content) : existing.toString("utf8") === content) {
      return false;
    }
  } catch {
    // missing — fall through to write
  }
  await writeFile(path, content);
  return true;
}

async function main() {
  if (!existsSync(SRC)) {
    console.error(`[sync-composition] parent project dir does not exist: ${SRC}`);
    process.exit(1);
  }

  await mkdir(DEST, { recursive: true });

  const files = await listFiles(SRC);
  const wantSet = new Set(files);
  console.log(`[sync-composition] project: ${project.projectId}`);
  console.log(`[sync-composition] syncing ${files.length} files from ${SRC} → ${DEST}`);
  console.log(`[sync-composition] rewriting asset URLs to ${R2_BASE}`);

  let rewroteCount = 0;
  let writtenCount = 0;

  for (const rel of files) {
    const srcPath = join(SRC, rel);
    const destPath = join(DEST, rel);
    await mkdir(dirname(destPath), { recursive: true });

    if (rel.endsWith(".html")) {
      const original = await readFile(srcPath, "utf8");
      const rewritten = rewrite(original);
      if (rewritten !== original) rewroteCount += 1;
      if (await writeFileIfChanged(destPath, rewritten)) writtenCount += 1;
    } else {
      const content = await readFile(srcPath);
      if (await writeFileIfChanged(destPath, content)) writtenCount += 1;
    }
  }

  // Remove any files in DEST that no longer exist in SRC (deletions propagate
  // without wiping the whole tree, which the bundler may be reading).
  const existing = await listFiles(DEST);
  let removedCount = 0;
  for (const rel of existing) {
    if (!wantSet.has(rel)) {
      await unlink(join(DEST, rel));
      removedCount += 1;
    }
  }

  console.log(
    `[sync-composition] done — ${writtenCount} written, ${rewroteCount} HTML rewrites, ${removedCount} removed`,
  );
}

main().catch((err) => {
  console.error("[sync-composition] failed:", err);
  process.exit(1);
});
