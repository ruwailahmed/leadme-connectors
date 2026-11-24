FROM node:24-bookworm-slim

# Chromium is the session. No Playwright/Puppeteer: the app talks to it over CDP directly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation fonts-dejavu-core tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_BIN=/usr/bin/chromium \
    AUTH_HEADLESS=1 \
    PORT=7860 \
    DATA_DIR=/tmp/leadme

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY vercel.json railway.json nixpacks.toml ./

EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--env-file-if-exists=.env", "src/server.ts"]
