# Playwright's own image already carries Chromium and every system library it
# needs. Keep the tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    PORT=3050 \
    HOST=0.0.0.0 \
    SCRAPER_OUTPUT_DIR=/data \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Dependencies first so edits to src/ don't invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY public ./public

# Scraped files land on a volume so they survive container replacement.
RUN mkdir -p /data && chown -R pwuser:pwuser /app /data
VOLUME ["/data"]

USER pwuser
EXPOSE 3050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3050)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/server.js"]
