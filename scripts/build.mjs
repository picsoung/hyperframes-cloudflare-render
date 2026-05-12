// Run by wrangler dev/deploy via build.command. The manifest exists because
// the ASSETS binding can fetch but not list. The bundle exists because the
// player can't stitch sub-compositions together at preview time without it.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadProject } from "./lib/project.mjs";

// Resolution: PREVIEW_COMPOSITION_DIR env (set by wrangler build.command in
// dev/deploy) takes precedence; otherwise derive from .cloudrender.json.
// Erroring here is fine — the manifest is required for the Worker to serve
// composition files to the container, so we can't silently fall back.
const COMP_DIR = process.env.PREVIEW_COMPOSITION_DIR ?? loadProject().compositionDirRel;
const ROOT = "public";
const compRoot = join(ROOT, COMP_DIR);

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

// Idempotent write — only touches the file if content differs. Prevents
// `wrangler dev` from looping forever when its watcher sees the manifest
// being rewritten on every build.
async function writeIfChanged(path, content, label) {
  await mkdir(dirname(path), { recursive: true });
  let existing = null;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // missing — fall through to write
  }
  if (existing === content) {
    console.log(`[build] ${label} unchanged (${content.length} bytes)`);
    return;
  }
  await writeFile(path, content);
  console.log(`[build] wrote ${label} (${content.length} bytes)`);
}

async function writeManifest() {
  const files = (await listFiles(compRoot)).filter(
    (rel) => !rel.startsWith("_bundled/"),
  );
  const out = "src/composition-manifest.json";
  const content = JSON.stringify({ dir: COMP_DIR, files }, null, 2) + "\n";
  await writeIfChanged(out, content, `${out} with ${files.length} files from ${compRoot}`);
}

async function bundlePreview() {
  const out = "public/_bundled/preview.html";
  await mkdir(dirname(out), { recursive: true });
  const tsxBin = join("node_modules", ".bin", "tsx");

  const html = await new Promise((resolveBundle, reject) => {
    const child = spawn(tsxBin, ["scripts/bundle-preview.ts", compRoot], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      if (code === 0) resolveBundle(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`bundle-preview.ts exited ${code}`));
    });
    child.on("error", reject);
  });

  await writeIfChanged(out, html, out);
}

async function copyPlayer() {
  const src = "node_modules/@hyperframes/player/dist/hyperframes-player.global.js";
  const dest = "public/_hyperframes/player.js";
  await mkdir(dirname(dest), { recursive: true });
  // copyFile always touches mtime; only copy if size differs (cheap check)
  let existingSize = -1;
  try {
    const { size } = await (await import("node:fs/promises")).stat(dest);
    existingSize = size;
  } catch {}
  const { size: srcSize } = await (await import("node:fs/promises")).stat(src);
  if (existingSize === srcSize) {
    console.log(`[build] ${dest} unchanged`);
    return;
  }
  await copyFile(src, dest);
  console.log(`[build] copied ${dest}`);
}

await writeManifest();
await bundlePreview();
await copyPlayer();
