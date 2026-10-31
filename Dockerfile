# Точная версия Node.js, как в .nvmrc: сборка падает, если установлена другая.
ARG NODE_VERSION=24.22.2

FROM ubuntu:24.04 AS builder
WORKDIR /app

# Устанавливаем Node.js 24 и необходимые инструменты
ARG NODE_VERSION
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs=${NODE_VERSION}-1nodesource1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(node -v)" = "v${NODE_VERSION}"

# Включаем corepack для использования pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Копируем файлы для установки зависимостей
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm.patchedDependencies (patches/) применяется во время install.
COPY patches ./patches
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/

# Устанавливаем зависимости
RUN pnpm install --frozen-lockfile

# Копируем весь проект
COPY . .

# Передаём Vite env в build stage до сборки frontend.
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENABLED
ARG VITE_SENTRY_ENVIRONMENT
ARG VITE_SENTRY_RELEASE
ARG VITE_SENTRY_TRACES_SAMPLE_RATE
ARG VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE
ARG VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE

ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_ENABLED=$VITE_SENTRY_ENABLED \
    VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT \
    VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE \
    VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE \
    VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE \
    VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE

# 1. Собираем shared (зависимость для frontend и backend)
RUN pnpm --filter shared build

# 2. Собираем frontend
RUN pnpm --filter frontend build

# 3. Собираем backend
RUN pnpm --filter backend build

# 4. Копируем собранный frontend в папку public backend
RUN rm -rf packages/backend/public && \
    cp -r packages/frontend/dist packages/backend/public


# --- Этап 2: продакшн ---
FROM ubuntu:24.04 AS production
WORKDIR /app

# Устанавливаем Node.js 24 и необходимые инструменты
ARG NODE_VERSION
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs=${NODE_VERSION}-1nodesource1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(node -v)" = "v${NODE_VERSION}"

# Включаем corepack для использования pnpm. COREPACK_HOME вне /root, чтобы
# пользователь app (one-shot `pnpm db:migrate`) брал уже скачанный pnpm без сети.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
    && chmod -R a+rX /opt/corepack

# Непривилегированный пользователь (code-issues item 29). Домашний каталог нужен
# pnpm для кэша при one-shot запусках миграций.
RUN groupadd --system app \
    && useradd --system --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app

# Копируем файлы для установки зависимостей
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm.patchedDependencies (patches/) применяется во время install.
COPY patches ./patches
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/

# Только production-зависимости: drizzle-kit (миграции) — в dependencies backend,
# create-database запускается из dist, поэтому tsx и прочие devDependencies не нужны
RUN pnpm install --frozen-lockfile --prod --filter backend...

ENV NODE_ENV=production \
    APP_ENV=production \
    SERVE_STATIC=true

# Копируем собранный код backend и shared
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Копируем public (frontend build) и public-test
COPY --from=builder /app/packages/backend/public ./packages/backend/public
COPY --from=builder /app/packages/backend/public-test ./packages/backend/public-test

# Копируем конфигурационные файлы для drizzle-kit
COPY --from=builder /app/packages/backend/drizzle.config.ts ./packages/backend/drizzle.config.ts
# drizzle.config.ts reads DB settings from this module (shared with the app and db:create)
COPY --from=builder /app/packages/backend/src/config/database.ts ./packages/backend/src/config/database.ts
# Копируем миграции drizzle
COPY --from=builder /app/packages/backend/src/drizzle/migrations ./packages/backend/src/drizzle/migrations

# Копируем базу знаний поддержки
COPY --from=builder /app/docs/support-knowledge-base ./docs/support-knowledge-base

# Открываем порт 3000
EXPOSE 3000

WORKDIR /app/packages/backend

# Файлы приложения принадлежат root и только читаются; процесс работает от app.
USER app

# Readiness через /api/ready: 200 лишь когда отвечают PostgreSQL и Redis.
# Проверяется тело, а не только код: при SERVE_STATIC неизвестный путь отдаёт
# index.html со статусом 200 (SPA fallback). Если задан другой PORT или
# API_PATH_PREFIX, переопределите проверку при запуске (--health-cmd), см.
# documentation/backend/deployment.md. /api/ping остаётся liveness без зависимостей.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/ready" | grep -q '"status":"ok"' || exit 1

# PID 1 — Node, поэтому SIGTERM от `docker stop` доходит до stopGracefully.
# Миграции не запускаются на старте (code-issues item 30): это отдельные one-shot
# запуски того же образа перед rollout:
#   docker run --rm --env-file .env <image> pnpm db:create:prod
#   docker run --rm --env-file .env <image> pnpm db:migrate
CMD ["node", "dist/index.js"]
