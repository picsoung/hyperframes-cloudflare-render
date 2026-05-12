// Single source of truth for "what HyperFrames project is this renderer
// attached to". cloudflare-render/ is designed to be dropped in as a nested
// sub-folder of an existing HyperFrames project. The parent dir (..) is that
// project. All downstream config — worker name, R2 bucket names, the
// composition directory under public/ — is derived from the parent's
// package.json `name` field.
//
// Resolution order:
//   1. cloudflare-render/.cloudrender.json (cached values from a prior run)
//   2. ../package.json `.name` field
//   3. ../meta.json `.id` or `.name` field
//
// Throws loudly if nothing identifies the parent — the rest of the pipeline
// can't function without a project ID.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const PARENT_DIR = resolve(ROOT, "..");
const CONFIG_PATH = resolve(ROOT, ".cloudrender.json");

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err.message}`);
  }
}

function deriveProjectId() {
  const pkg = readJsonIfExists(resolve(PARENT_DIR, "package.json"));
  if (pkg?.name) return slugify(pkg.name);

  const meta = readJsonIfExists(resolve(PARENT_DIR, "meta.json"));
  if (meta?.id) return slugify(meta.id);
  if (meta?.name) return slugify(meta.name);

  throw new Error(
    `Cannot determine project identity.\n` +
      `  cloudflare-render/ expects to live inside a HyperFrames project — i.e. its parent dir\n` +
      `  (${PARENT_DIR}) should contain a package.json with a "name" field, or a meta.json with\n` +
      `  an "id" or "name". Neither was found.\n\n` +
      `  If you're testing this template standalone, create a minimal package.json in the parent:\n` +
      `      { "name": "my-project", "private": true }`,
  );
}

function buildConfig(projectId) {
  return {
    projectId,
    parentDir: PARENT_DIR,
    workerName: `hyperframes-${projectId}`,
    assetsBucket: `hyperframes-${projectId}-assets`,
    rendersBucket: `hyperframes-${projectId}-renders`,
    assetsBinding: "PARENT_ASSETS",
    rendersBinding: "RENDERS",
    compositionDirName: projectId,
    // The relative path used inside public/ for synced composition files.
    // Build scripts use this for both src/composition-manifest.json's `dir`
    // field and for sync output paths.
    compositionDirRel: `compositions/${projectId}`,
  };
}

let cached;

/**
 * @param {{ refresh?: boolean }} [opts]
 * @returns {{
 *   projectId: string,
 *   parentDir: string,
 *   workerName: string,
 *   assetsBucket: string,
 *   rendersBucket: string,
 *   assetsBinding: string,
 *   rendersBinding: string,
 *   compositionDirName: string,
 *   compositionDirRel: string,
 * }}
 */
export function loadProject({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  // Fast path: prior run already persisted derived values. We still re-check
  // the parent's project ID and refresh if it changed (rare but cheap).
  const existing = readJsonIfExists(CONFIG_PATH);
  const projectId = deriveProjectId();

  if (existing?.projectId === projectId) {
    cached = existing;
    return cached;
  }

  const config = buildConfig(projectId);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  cached = config;
  return cached;
}

export function projectConfigPath() {
  return CONFIG_PATH;
}

export function projectRoot() {
  return ROOT;
}
