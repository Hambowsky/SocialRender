# Official Playwright image: Chromium and its system libraries already installed, Node 22.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

# ffmpeg turns motion template frames into MP4 clips.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /data && chown -R pwuser:pwuser /data
USER pwuser

VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "src/server.ts"]
