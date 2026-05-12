# Render container: Node 22 + Chromium system libs + hyperframes + ffmpeg.
# Bakes the renderer at build time so cold-start is just container provisioning,
# not package install. Composition files are sent in the request body.
#
# Pulling from AWS ECR Public's mirror of Docker Hub library images instead of
# Docker Hub directly — Docker Hub serves through a Cloudflare CDN that has
# been intermittently failing with DeadlineExceeded errors. ECR Public mirrors
# the same `library/node` content but distributes through Amazon's CDN.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# Chromium runtime libs + ffmpeg (which also ships ffprobe). Installing from
# Debian repos instead of npm ffmpeg-static avoids platform-detection issues
# and gives both binaries on $PATH at /usr/bin/ in one step.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version \
  && ffprobe -version

WORKDIR /app

# Install hyperframes. ffmpeg + ffprobe come from apt above.
COPY container/package.json ./package.json
RUN npm install --no-audit --no-fund

# Pre-download chrome-headless-shell so the first render doesn't pay for it.
RUN npx --no-install hyperframes browser ensure

# The render server.
COPY container/server.mjs ./server.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
