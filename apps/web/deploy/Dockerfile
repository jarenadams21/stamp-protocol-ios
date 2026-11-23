# The test site (api mode) as a container: the built page behind nginx, which passes /v1 to the API
# running next to it in the same container app (deploy/README.md). Build from apps/web:
#   az acr build --registry <registry> --image joeyy-web-test:<tag> --file deploy/Dockerfile .
FROM node:22-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build --mode api --outDir dist

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
