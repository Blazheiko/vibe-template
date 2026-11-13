# План: Docker hardening (feat-019, F02)

Пункти 28, 29, 30 з [`code-issues-found-during-docs.md`](./code-issues-found-during-docs.md). Roadmap: [F02](./open-issues-roadmap.md); задачі: F02.1–F02.7 у [`open-issues-tasks.md`](./open-issues-tasks.md).

## Вихідний стан (`main` після PR #65)

- Обидва етапи `Dockerfile` — `ubuntu:24.04`, Node 24 з NodeSource, `corepack` + `pnpm@9.15.0`. Користувача `node` немає (є лише `ubuntu`, uid 1000); процес працює від root.
- `.dockerignore` немає, `COPY . .` у builder-етапі забирає локальні `.env`, `node_modules`, `dist`, `.git`.
- `CMD ["sh", "-c", "node --version && pnpm db:create:prod && pnpm db:migrate && pnpm start"]`: міграції на кожному старті, PID 1 — `sh`, тож `SIGTERM` від `docker stop` може не дійти до Node (обробник у `src/index.ts`).
- `HEALTHCHECK` немає. Production-етап має `curl`.
- Застосунок у рантаймі нічого не пише на диск (статику читає з `public` у пам'ять, файли — в S3).

## Рішення

1. **`.dockerignore`** за переліком roadmap; `!**/.env.example` лишається, бо його читає документація, а не збірка.
2. **Користувач:** `groupadd --system app && useradd --system --gid app --create-home --home-dir /home/app app`. Домашній каталог потрібен `corepack`/`pnpm` для one-shot запусків (`pnpm db:migrate` пише кеш у `$HOME`). Файли застосунку лишаються у власності root і лише читаються; `USER app` — після всіх `COPY`.
3. **`HEALTHCHECK`:** `curl -fsS http://127.0.0.1:${PORT:-3000}/api/ping`, `--interval=30s --timeout=3s --start-period=20s --retries=3`. Порт — `PORT` (його читає `config/app.ts`), префікс — `api` за замовчуванням; при іншому `API_PATH_PREFIX` healthcheck перевизначається при запуску (`--health-cmd`), це описано в `deployment.md`.
4. **`CMD ["node", "dist/index.js"]`** з `WORKDIR /app/packages/backend`: PID 1 — Node, сигнали доходять до `stopGracefully`. Міграції — окремі one-shot запуски того самого образу перед rollout: `docker run --rm --env-file … <img> pnpm db:create:prod`, потім `… pnpm db:migrate`.
5. **Перевірка секретів** — canary-маркер у `.env` і `packages/backend/.env`, три перевірки (builder-етап, шари `docker save`, `docker history`); розмір build context — лише допоміжне свідчення.

## Кроки

| Крок | Зміст                                                         | Задача |
| ---- | ------------------------------------------------------------- | ------ |
| 1    | baseline: розмір образу, час збірки, build context            | F02.1  |
| 2    | `.dockerignore`                                               | F02.2  |
| 3    | canary-перевірки                                              | F02.3  |
| 4    | користувач `app`                                              | F02.4  |
| 5    | `HEALTHCHECK` (+ сценарій `unhealthy` з `API_PATH_PREFIX=v1`) | F02.5  |
| 6    | `CMD` без shell, one-shot міграції, graceful shutdown         | F02.6  |
| 7    | повторні вимірювання                                          | F02.7  |
| 8    | `deployment.md`                                               | F02.D  |

## Ризики

- **Зміна контракту запуску:** хто запускав образ і чекав міграцій на старті, тепер має запускати їх окремо. Описати в `deployment.md` і в описі PR як breaking change для деплою.
- **Перевірки потребують Docker і PostgreSQL** (для старту застосунку й one-shot міграцій): одноразовий `pgvector/pgvector:pg16` і Redis у спільній docker-мережі.

## Доповнення: закріплення ланцюга постачання (feat-207, 2026-11-13)

Знахідки L-18 та I-5 з [`security-review-2026-11-12.md`](../security/security-review-2026-11-12.md), рішення Д7.

- **Базовий образ за digest.** Обидва етапи: `FROM ubuntu:24.04@sha256:…`. Тег лишається для читача, збірку визначає digest. Оновлює Dependabot (екосистема `docker` у `.github/dependabot.yml`).
- **NodeSource без `curl | bash`.** `Dockerfile` сам додає apt-репозиторій: ключ підпису завантажується в `/etc/apt/keyrings/nodesource.asc` і звіряється з `NODESOURCE_ASC_SHA256`; пакети apt перевіряє за цим ключем. Версія Node, як і раніше, закріплена (`nodejs=${NODE_VERSION}-1nodesource1`) і звіряється з `node -v`. Коли NodeSource замінить ключ, збірка зупиниться на `sha256sum -c`: це навмисно.
- **`public-test` поза образом.** `COPY … public-test` з production-етапу прибрано; режим `APP_ENV=manual-test` — локальний.
- **Чого не зроблено.** `curl` лишається в runtime-образі: його використовує `HEALTHCHECK`. Перехід на `node:24-slim` відхилено рішенням Д7 (менше змін у перевіреному образі).
