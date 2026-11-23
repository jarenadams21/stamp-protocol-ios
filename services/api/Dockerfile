# The JOEYY API (services/api) as a container. Build from services/api:
#   docker build -t joeyy-api .
#   az acr build --registry <registry> --image joeyy-api:<tag> .
# Configuration comes from environment variables at run time (see .env.example); no .env file or
# secret is copied into the image (.dockerignore).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY db ./db
COPY scripts ./scripts
# AUTH_MODE=dev and IMAGE_STORE=local write under .dev/; everything else stays read-only to the app.
RUN mkdir .dev && chown node:node .dev

USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
