# --- Build stage ---
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npx -w client vite build
RUN npm run build -w server
RUN cp server/src/lib/schema.sql server/dist/lib/

# --- Production deps stage ---
FROM node:20-bookworm-slim AS deps

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev

# --- Runtime stage ---
FROM node:20-bookworm-slim

# Playwright Chromium system deps + Japanese/CJK fonts
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production node_modules (hoisted by npm workspaces)
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/server/package.json server/

# Built artifacts
COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/client/dist client/dist

# Install Playwright Chromium browser binary
RUN npx playwright install chromium

ENV NODE_ENV=production
EXPOSE 3100

CMD ["node", "server/dist/index.js"]
