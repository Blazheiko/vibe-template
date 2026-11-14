# The landing as a static site: built with Node, served by nginx (docs/plan/landing-plan.md).
# Build from the repository root, it needs the workspace and packages/shared:
#   docker build -f packages/landing/Dockerfile \
#     --build-arg LANDING_APP_URL=https://app.example.com \
#     --build-arg LANDING_SITE_URL=https://example.com -t landing .
# The addresses are compiled into the HTML, so another domain needs another build. The build is
# strict by default (packages/landing/build/urls.ts): https only, no localhost or placeholder
# domains; scripts/docker-build.sh passes LANDING_STRICT=false for the local compose stack.
# nginx serves the files only. TLS, domains and redirects belong to the proxy in front of it
# (Traefik in Dokploy), so the container listens on plain http :8080 as a non-root user.

# Base images are pinned by digest; Dependabot (ecosystem `docker`) moves them.
FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Dependencies first, for the layer cache. pnpm.patchedDependencies (patches/) is checked on install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/
COPY packages/landing/package.json ./packages/landing/
RUN pnpm install --frozen-lockfile --filter landing...

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/landing ./packages/landing

# No defaults: a build without the addresses would quietly point the buttons at localhost.
ARG LANDING_APP_URL
ARG LANDING_SITE_URL
ARG LANDING_STRICT=true
RUN test -n "$LANDING_APP_URL" && test -n "$LANDING_SITE_URL" || { \
        echo 'Set --build-arg LANDING_APP_URL=<app origin> and --build-arg LANDING_SITE_URL=<landing origin>' >&2; \
        exit 1; \
    }
ENV LANDING_APP_URL=$LANDING_APP_URL \
    LANDING_SITE_URL=$LANDING_SITE_URL \
    LANDING_STRICT=$LANDING_STRICT

# The landing build ends with the dist/ checks (build/verify-dist.ts): a broken page fails here.
RUN pnpm --filter shared build && pnpm --filter landing build


FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS production

COPY packages/landing/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY packages/landing/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=builder /app/packages/landing/dist /usr/share/nginx/html

EXPOSE 8080
USER nginx
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
