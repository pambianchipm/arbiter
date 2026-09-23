# Arbiter production image. Playwright's base image ships Chromium and every system library it needs.
# Keep this tag in step with the "playwright" version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Install with dev deps (TypeScript) to build, then drop them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production \
    DATA_DIR=/data
# Railway injects PORT; the preview/landing/billing server listens on it.
EXPOSE 3939
CMD ["node", "dist/src/index.js"]
