// Local smoke test for the sync + build pipeline. No Cloudflare account, no
// Docker, no real R2. Catches >90% of refactor bugs by:
//
//   1. Copying test/fixtures/hello-cloudrender/ to a temp dir as the parent
//      HyperFrames project
//   2. Copying this cloudflare-render/ tree to a nested sub-folder there (with
//      node_modules symlinked back to the source so we don't reinstall)
//   3. Stubbing R2_ASSETS_BASE in .env
//   4. Running scripts/sync-composition.mjs + scripts/build.mjs
//   5. Asserting the generated artifacts (.cloudrender.json, wrangler.jsonc,
//      synced composition, manifest, preview bundle) are correct
//
// Run with `npm run test:local`. Exit 0 on pass, 1 on fail, with a diff-style
// report on the first failed assertion.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SRC_ROOT = resolve(new URL("..", import.meta.url).pathname);
const FIXTURE_SRC = join(SRC_ROOT, "test/fixtures/hello-cloudrender");
const STUB_R2_BASE = "https://example.test/stub-r2";

if (!existsSync(FIXTURE_SRC)) {
  fail(`fixture not found at ${FIXTURE_SRC}`);
}

// ---------- 1. Stage temp working tree ----------

const work = mkdtempSync(join(tmpdir(), "hyperframes-cloudrender-test-"));
const parent = join(work, "hello-cloudrender");
const nested = join(parent, "cloudflare-render");

console.log(`[test:local] staging in ${work}`);

// Parent = the fixture, but copied (so .cloudrender.json writes don't pollute
// the source tree even if logic later climbed there).
cpSync(FIXTURE_SRC, parent, { recursive: true });

// Nested cloudflare-render = a clone of SRC_ROOT minus generated/installed
// state. We do an explicit allowlist instead of a `.gitignore`-style filter
// to keep the test self-contained.
const NESTED_INCLUDE = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "wrangler.template.jsonc",
  "Dockerfile",
  ".gitignore",
  "scripts",
  "src",
  "container",
  "public",
];
mkdirSync(nested, { recursive: true });
for (const rel of NESTED_INCLUDE) {
  const from = join(SRC_ROOT, rel);
  if (!existsSync(from)) continue;
  cpSync(from, join(nested, rel), { recursive: true });
}

// Wipe any synced/generated artifacts that snuck through (defensive — the
// allowlist should already exclude these).
const NESTED_PURGE = [
  "public/compositions",
  "public/_bundled",
  "public/_hyperframes",
  "src/composition-manifest.json",
  ".cloudrender.json",
  "wrangler.jsonc",
];
for (const rel of NESTED_PURGE) {
  const p = join(nested, rel);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// Symlink node_modules back to the source install so we don't pay the npm install cost.
const srcNodeModules = join(SRC_ROOT, "node_modules");
if (!existsSync(srcNodeModules)) {
  fail(
    `node_modules missing at ${srcNodeModules}. Run \`npm install\` in cloudflare-render/ before \`npm run test:local\`.`,
  );
}
symlinkSync(srcNodeModules, join(nested, "node_modules"), "dir");

// Stub .env with a fake R2 base.
writeFileSync(join(nested, ".env"), `R2_ASSETS_BASE=${STUB_R2_BASE}\n`, "utf8");

// ---------- 2. Run the pipeline ----------

function run(label, cmd, args) {
  console.log(`[test:local] ${label}`);
  const r = spawnSync(cmd, args, { cwd: nested, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    fail(`${label} exited ${r.status}`);
  }
}

run("ensure-wrangler-config", "node", ["scripts/ensure-wrangler-config.mjs"]);
run("sync-composition", "node", ["scripts/sync-composition.mjs"]);
run("build", "node", ["scripts/build.mjs"]);

// ---------- 3. Assertions ----------

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push({ label, ok: true });
  } catch (err) {
    checks.push({ label, ok: false, err: err.message });
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

check(".cloudrender.json has projectId hello-cloudrender", () => {
  const cfg = readJson(join(nested, ".cloudrender.json"));
  if (cfg.projectId !== "hello-cloudrender") {
    throw new Error(`projectId=${cfg.projectId}`);
  }
  if (cfg.workerName !== "hyperframes-hello-cloudrender") {
    throw new Error(`workerName=${cfg.workerName}`);
  }
  if (cfg.assetsBucket !== "hyperframes-hello-cloudrender-assets") {
    throw new Error(`assetsBucket=${cfg.assetsBucket}`);
  }
  if (cfg.rendersBucket !== "hyperframes-hello-cloudrender-renders") {
    throw new Error(`rendersBucket=${cfg.rendersBucket}`);
  }
});

check("wrangler.jsonc generated with derived names, no placeholders left", () => {
  const out = readFileSync(join(nested, "wrangler.jsonc"), "utf8");
  if (out.includes("<<")) throw new Error("unfilled <<placeholder>> in output");
  if (!out.includes('"hyperframes-hello-cloudrender"')) {
    throw new Error('expected worker "hyperframes-hello-cloudrender"');
  }
  if (!out.includes("hyperframes-hello-cloudrender-renders")) {
    throw new Error("expected renders bucket name");
  }
});

check("public/compositions/hello-cloudrender/index.html exists", () => {
  const p = join(nested, "public/compositions/hello-cloudrender/index.html");
  if (!existsSync(p)) throw new Error(`missing ${p}`);
});

check("synced index.html has R2 URLs (no relative assets/audio or assets/videos)", () => {
  const html = readFileSync(
    join(nested, "public/compositions/hello-cloudrender/index.html"),
    "utf8",
  );
  if (html.includes("assets/videos/clip.mp4") && !html.includes(`${STUB_R2_BASE}/videos/clip.mp4`)) {
    throw new Error("relative videos/ path not rewritten");
  }
  if (html.includes("assets/audio/beep.mp3") && !html.includes(`${STUB_R2_BASE}/audio/beep.mp3`)) {
    throw new Error("relative audio/ path not rewritten");
  }
  if (!html.includes(`${STUB_R2_BASE}/videos/clip.mp4`)) {
    throw new Error("rewritten video URL not found");
  }
  if (!html.includes(`${STUB_R2_BASE}/audio/beep.mp3`)) {
    throw new Error("rewritten audio URL not found");
  }
});

check("synced compositions/intro.html has R2 URLs (parent-relative ../assets/...)", () => {
  const html = readFileSync(
    join(nested, "public/compositions/hello-cloudrender/compositions/intro.html"),
    "utf8",
  );
  if (!html.includes(`${STUB_R2_BASE}/videos/clip.mp4`)) {
    throw new Error("sub-comp video URL not rewritten");
  }
  if (!html.includes(`${STUB_R2_BASE}/audio/beep.mp3`)) {
    throw new Error("sub-comp audio URL not rewritten");
  }
});

check("manifest lists composition files, excludes heavy media", () => {
  const manifest = readJson(join(nested, "src/composition-manifest.json"));
  if (manifest.dir !== "compositions/hello-cloudrender") {
    throw new Error(`manifest.dir=${manifest.dir}`);
  }
  const files = manifest.files;
  if (!files.includes("index.html")) throw new Error("missing index.html in manifest");
  if (!files.includes("compositions/intro.html")) throw new Error("missing intro.html");
  if (!files.includes("assets/images/logo.svg")) throw new Error("missing logo.svg");
  for (const f of files) {
    if (f.startsWith("assets/videos/")) throw new Error(`video should be skipped: ${f}`);
    if (f.startsWith("assets/audio/")) throw new Error(`audio should be skipped: ${f}`);
  }
});

check("preview bundle exists and is non-empty", () => {
  const p = join(nested, "public/_bundled/preview.html");
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const size = readFileSync(p, "utf8").length;
  if (size < 1024) throw new Error(`preview.html too small: ${size} bytes`);
});

check("player runtime copied to public/_hyperframes/player.js", () => {
  const p = join(nested, "public/_hyperframes/player.js");
  if (!existsSync(p)) throw new Error(`missing ${p}`);
});

// ---------- 4. Report ----------

const passed = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok);

console.log("");
for (const c of checks) {
  if (c.ok) console.log(`  ✓ ${c.label}`);
  else console.log(`  ✗ ${c.label}\n    ${c.err}`);
}
console.log(`\n${passed}/${checks.length} passed`);

if (failed.length > 0) {
  console.error(`\n[test:local] FAIL — temp tree preserved at ${work} for inspection`);
  process.exit(1);
}

// Cleanup only on success — failures leave the temp tree for debugging.
rmSync(work, { recursive: true, force: true });
console.log("[test:local] PASS");

function fail(msg) {
  console.error(`[test:local] ${msg}`);
  process.exit(1);
}
