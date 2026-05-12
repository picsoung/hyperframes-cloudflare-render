# Cloud render — setup, troubleshooting, cleanup

The repo's top-level `README.md` has the short version. This file covers the long version + every workaround we've collected.

## Quickstart

`cloudflare-render/` is designed to live inside an existing HyperFrames project as a nested sub-folder:

```
my-hf-project/
├── package.json            # { "name": "my-hf-project" } — drives every derived name
├── index.html              # your composition
├── compositions/
├── assets/
│   ├── videos/             # heavy media → uploaded to R2 (private)
│   ├── audio/              # heavy media → uploaded to R2 (private)
│   └── images/             # small files → bundled into the worker
└── cloudflare-render/      # ← this template
```

End-to-end:

```bash
cd my-hf-project
git clone <template-url> cloudflare-render
cd cloudflare-render
npm install
npx wrangler login          # if not already
npm run setup               # derive identity, create R2 bucket, upload videos/audio
# (follow prompt: enable R2 public access in dashboard, paste URL into .env)
npm run setup               # re-run; verifies the public URL works
npm run deploy              # build + push container, deploy Worker
npm run render:cloud        # one-command render → ./renders/<project>-*.mp4
```

Requires:
- A parent HyperFrames project (one dir up) with a `package.json` `.name` field
- Cloudflare account on **Workers Paid plan** ($5/mo min, Containers needs it)
- Docker Desktop (only during `npm run deploy` for image build)
- macOS or Linux shell. WSL2 also works.

## What each script does

### `npm run setup`

Idempotent. Reads `../package.json` `.name` and writes derived names (`hyperframes-<projectId>` for the worker, `hyperframes-<projectId>-assets` and `hyperframes-<projectId>-renders` for the buckets) to `.cloudrender.json`. Regenerates `wrangler.jsonc` from `wrangler.template.jsonc`. Then: `wrangler whoami`, create assets bucket if missing, upload any video/audio asset from `../assets/{videos,audio}/` that isn't already there, install auto-expire lifecycle rules on both R2 buckets, and verify the public URL works once you've added it to `.env`.

**Auto-expire rules (set on first setup):**

| Bucket                                  | Retention | Rationale                                                    |
| --------------------------------------- | --------- | ------------------------------------------------------------ |
| `hyperframes-<project>-assets`          | 14 days   | Re-running `npm run setup` re-uploads only what's missing.   |
| `hyperframes-<project>-renders`         | 7 days    | Renders are downloaded locally by `render:cloud`; old ones are noise. |

To change retention, edit `ASSETS_EXPIRE_DAYS` / `RENDERS_EXPIRE_DAYS` at the top of `scripts/setup-r2.mjs` and re-run `npm run setup`. To remove a rule entirely:

```bash
npx wrangler r2 bucket lifecycle remove hyperframes-<project>-assets
```

After the first run, you'll see something like:

```
=== R2 public access ===
  → R2_ASSETS_BASE is not set. To finish setup:
      1. Open the Cloudflare dashboard: ...
      2. Under "R2.dev subdomain" click Allow Access.
      3. Copy the resulting URL (looks like https://pub-<hash>.r2.dev).
      4. Save it to cloudflare-render/.env:
           R2_ASSETS_BASE=https://pub-<hash>.r2.dev
      5. Re-run `npm run setup` — it'll verify the URL works.
```

Do those four manual steps once, re-run `npm run setup` to verify, then move on to deploy.

### `npm run deploy`

`predeploy` regenerates `wrangler.jsonc` from the template (in case `.cloudrender.json` changed). Then standard `wrangler deploy`. Builds the container image (~3 min uncached, ~30 s incremental), pushes to Cloudflare's image registry, updates the running container instance, and deploys the Worker. After every deploy, the Durable Object resets — wait ~30 s before the first render or the request may 5xx during the reset window.

### `npm run render:cloud`

Hides the two-step API: POST `/api/render`, parse the returned `{url: "/r/<key>"}`, GET that URL, save to `renders/<projectId>-YYYYMMDD-HHMMSS.mp4`. Opens it on macOS. Resolves the Worker URL from CLI arg → `WORKER_URL` in `.env` → `wrangler deployments list`.

Use a specific Worker URL:

```bash
npm run render:cloud -- https://hyperframes-<project>.<your-sub>.workers.dev
```

### `npm run test:local`

Smoke-tests the local pipeline (sync + build, no real Cloudflare account needed). Copies `test/fixtures/hello-cloudrender/` to a temp dir, drops cloudflare-render in as a nested folder, stubs `R2_ASSETS_BASE`, runs the build, and asserts the generated artifacts are correct. Run this before any release.

## Switching to a different parent project

`.cloudrender.json` caches the derived names. To re-point this template at a different HyperFrames project:

```bash
rm .cloudrender.json
npm run setup     # re-derives from the new ../package.json
```

The old R2 buckets stay around — delete them manually if you don't want them.

## Troubleshooting

### "Connection timed out" hitting `*.workers.dev`

If you're in Spain on a weekend with a match running, La Liga has court-ordered Movistar/Vodafone/Orange to block large Cloudflare anycast prefixes (`188.114.0.0/16` is a frequent victim) during match windows. Solutions:

1. **Cloudflare WARP** — `brew install --cask cloudflare-warp`, open the app, toggle on. Routes through Cloudflare's own backbone, bypasses the ISP block. Most reliable fix.
2. **Mobile tether** — different ISP, different routing. Works if WARP isn't an option.
3. **Off-peak** — the block is typically only active during match windows. Try a few hours later.
4. **Custom domain** — bind a domain attached to Cloudflare to the Worker. Custom domains use different anycast prefixes that aren't on La Liga's block list. More setup but a permanent fix.

### `npm run deploy` hangs at `[internal] load metadata for docker.io/library/node`

Docker Hub's CDN routes via Cloudflare, which means the same La Liga block hits the base image pull. The Dockerfile is already using AWS ECR's mirror (`public.ecr.aws/docker/library/node`) to avoid this. If your local Docker config is overriding image resolution somehow, force a direct pull first:

```bash
docker pull public.ecr.aws/docker/library/node:22-bookworm-slim
npm run deploy
```

### "ffprobe not found" in the render error

This was an early bug — the container previously used `ffmpeg-static` which only ships `ffmpeg`, not `ffprobe`. The current Dockerfile installs ffmpeg from Debian repos (`apt-get install ffmpeg`), which provides both binaries on `$PATH`. If you see this error again, check that the layer that runs `apt-get install ... ffmpeg ...` succeeded.

### Render returns 502 within seconds (way too fast for a real render)

Usually a container-side error during startup. Check `wrangler tail --format pretty` in another terminal while running `npm run render:cloud`. The line right before the 502 has the actual reason:

- `Container error: Runtime signalled the container to exit due to a new version rollout` — you deployed and tried to render before the reset window finished. Wait 30 s and retry.
- `RenderContainer: fetch failed` — container reachable but its `/render` endpoint errored. Logs from server.mjs (with our `[render +Nms]` timestamps) will tell you where.

### `wrangler dev` enters an infinite build loop

Fixed. The original template's `scripts/build.mjs` rewrote `src/composition-manifest.json` on every build, which `wrangler dev`'s file watcher then picked up as a change, triggering another build. The patched version writes only when content actually changes — see the `writeIfChanged` helper in `scripts/build.mjs`.

### The composition has changed but the render shows the old version

The build syncs `../` → `public/compositions/<projectId>/` at deploy time. If you edited the composition but didn't redeploy, you're rendering the previous state. `npm run deploy` regenerates the synced copy and pushes a new container.

### "Cannot determine project identity"

`scripts/lib/project.mjs` couldn't find a `name` in `../package.json` (or an `id`/`name` in `../meta.json`). Either:
- You're running cloudflare-render outside a HyperFrames project — add a minimal `package.json` to the parent dir: `{"name": "my-project", "private": true}`
- Or the parent's `package.json` exists but has no `name` field — add one

## Cleanup

When you're done with a deployment, tear it down so the test account doesn't accumulate:

```bash
npx wrangler delete                                          # removes the worker
npx wrangler r2 bucket delete hyperframes-<project>-assets   # removes the assets bucket
npx wrangler r2 bucket delete hyperframes-<project>-renders  # removes the renders bucket
```

Replace `<project>` with the value from `.cloudrender.json`. The buckets must be empty (or you'll need `--force`, but wrangler doesn't expose that — easier to wait for the lifecycle rule to drain them first).

## Cost

- Workers Paid plan: $5/mo (required for Containers)
- R2 storage: ~$0.015/GB-month for whatever you upload (egress within Cloudflare is free)
- Per render: ~$0.01–0.02 on `standard-4` (4 vCPU, 12 GiB) for a typical 30–60 s composition
