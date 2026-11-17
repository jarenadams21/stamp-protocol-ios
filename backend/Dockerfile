# JOEYY backend API. Build from the backend/ folder:
#   docker build --platform linux/amd64 -t joeyy-api .
FROM node:24-bookworm-slim

# Wallet strip images render cafe names from SVG text, which needs a font.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p .dev && chown node:node .dev

ENV HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
