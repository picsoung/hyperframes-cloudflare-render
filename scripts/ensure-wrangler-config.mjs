// Render wrangler.template.jsonc → wrangler.jsonc, substituting <<PROJECT_ID>>
// with the slug derived from the parent HyperFrames project. Idempotent: only
// writes if the rendered content differs from what's already on disk, so
// `wrangler dev`'s file watcher doesn't loop.
//
// Invoked:
//   - At the top of `wrangler.template.jsonc`'s build.command (every dev/deploy)
//   - As a predeploy hook (npm run deploy) for the case where someone runs
//     `wrangler deploy` directly without `npm run setup` first
//   - From scripts/setup-r2.mjs before any wrangler r2 commands
//
// Fails loudly if the template is missing or projectId can't be derived.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProject, projectRoot } from "./lib/project.mjs";

const TEMPLATE_PATH = resolve(projectRoot(), "wrangler.template.jsonc");
const OUT_PATH = resolve(projectRoot(), "wrangler.jsonc");

function render() {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(
      `[ensure-wrangler-config] wrangler.template.jsonc not found at ${TEMPLATE_PATH}.\n` +
        `  This file should be committed alongside the rest of the template.`,
    );
    process.exit(1);
  }

  const project = loadProject();
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const rendered = template.replaceAll("<<PROJECT_ID>>", project.projectId);

  if (rendered.includes("<<")) {
    console.error(
      `[ensure-wrangler-config] unfilled placeholders remain in template:\n` +
        rendered.match(/<<[^>]+>>/g)?.join(", "),
    );
    process.exit(1);
  }

  let existing = "";
  try {
    existing = readFileSync(OUT_PATH, "utf8");
  } catch {
    // missing — fall through to write
  }
  if (existing === rendered) {
    console.log(`[ensure-wrangler-config] wrangler.jsonc unchanged (${project.workerName})`);
    return;
  }

  writeFileSync(OUT_PATH, rendered);
  console.log(`[ensure-wrangler-config] wrote wrangler.jsonc → worker ${project.workerName}`);
}

render();
