# Multi-stage image for ECS / any container host.
# Build args are baked into the static bundle at build time.
# Runtime: nginx serves `dist/` on port 8080.

# ---- build ----
FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Required Telegram credentials (https://my.telegram.org)
ARG TELEGRAM_API_ID
ARG TELEGRAM_API_HASH

# Public site URL (used for TG_PUBLIC_URL / share links)
ARG BASE_URL=https://web.telegram.org/a/

# production | staging | development
ARG APP_ENV=production

# Optional: absolute platform API origin. Leave empty to call `/platform-api`
# and let nginx proxy to PLATFORM_API_UPSTREAM at runtime.
ARG PLATFORM_API_ORIGIN=
ARG PLATFORM_API_KEY_WEBSITE=

# Optional git branch override for APP_REVISION
ARG HEAD=

ENV TELEGRAM_API_ID=$TELEGRAM_API_ID \
    TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
    BASE_URL=$BASE_URL \
    APP_ENV=$APP_ENV \
    PLATFORM_API_ORIGIN=$PLATFORM_API_ORIGIN \
    PLATFORM_API_KEY_WEBSITE=$PLATFORM_API_KEY_WEBSITE \
    HEAD=$HEAD \
    NODE_ENV=production

RUN test -n "$TELEGRAM_API_ID" || (echo "TELEGRAM_API_ID is required" && exit 1)
RUN test -n "$TELEGRAM_API_HASH" || (echo "TELEGRAM_API_HASH is required" && exit 1)
RUN echo "Building with APP_ENV=$APP_ENV BASE_URL=$BASE_URL PLATFORM_API_ORIGIN=$PLATFORM_API_ORIGIN"

RUN npm run build:production

# ---- runtime ----
FROM nginx:1.27-alpine AS runtime

# Used by /etc/nginx/templates/*.template via envsubst.
ENV PLATFORM_API_UPSTREAM=http://127.0.0.1:3000 \
    INTERNAL_AUTH_API_UPSTREAM=http://127.0.0.1:8081 \
    NGINX_ENVSUBST_FILTER=API_UPSTREAM

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# Non-root-friendly port for ECS / ALB target groups
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
