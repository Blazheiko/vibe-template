# Структура проєкту

Репозиторій — pnpm workspace. До нього входять усі пакети з `packages/*` і пакет `documentation` ([pnpm-workspace.yaml](https://github.com/Blazheiko/vibe-template/blob/main/pnpm-workspace.yaml)):

```yaml
packages:
    - 'packages/*'
    - 'documentation'
```

## Пакети workspace

| Пакет            | Шлях                      | Призначення                                                                                                                                                                                                            |
| ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`        | `packages/backend`        | HTTP/WebSocket-сервер на uWebSockets.js, Drizzle, Redis, S3, пошта, AI ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json))                                            |
| `frontend`       | `packages/frontend`       | Vue 3 + Vite застосунок: PWA, i18n, Pinia, Vitest, Playwright e2e ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json))                                                |
| `shared`         | `packages/shared`         | Спільні контракти: `brands`, `schemas`, `responses`, `errors`, `enums`, `utils`, `guards` — окремі subpath exports ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/package.json)) |
| `api-playground` | `packages/api-playground` | Vue-інструмент розробника для ручного тестування HTTP/WebSocket API ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/package.json))                                        |
| `documentation`  | `documentation`           | Цей сайт документації на VitePress ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/documentation/package.json))                                                                                   |

`frontend`, `backend` і `api-playground` залежать від `shared` через `workspace:*`, тому `shared` треба зібрати першим (`pnpm build:shared`).

## Ключові каталоги

```
.
├── packages/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── app/        # controllers, middlewares, repositories, routes, routing,
│   │   │   │               # services, start, state, transformers, validate, websocket
│   │   │   ├── config/     # конфігурація (app, auth, cors, csp, csrf, database, mail, redis…)
│   │   │   ├── database/   # db.ts, redis.ts, schema.ts, relations.ts
│   │   │   ├── db/         # create-database.ts, seed.ts
│   │   │   ├── drizzle/    # migrations/ (згенеровані drizzle-kit)
│   │   │   ├── openapi/    # невикористані заготовки (OpenAPI не генерується)
│   │   │   ├── scripts/    # службові скрипти (send-test-email.ts тощо)
│   │   │   ├── vendor/     # «ядро»: start/ (server, router), utils/, contracts/, types/
│   │   │   └── index.ts    # точка входу
│   │   └── drizzle.config.ts
│   ├── frontend/           # src/, public/, e2e/ (Playwright), vite.sw.config.ts
│   ├── shared/             # src/{brands,enums,errors,guards,responses,schemas,utils}, test/
│   └── api-playground/     # src/{components,composables,router,stores,views}
├── documentation/          # VitePress
├── Dockerfile
├── init.sh                 # install + typecheck + lint + test + build
├── feature_list.json
└── pnpm-workspace.yaml
```

Згенеровані каталоги (`dist/`, `node_modules/`, звіти Playwright, coverage) вручну не редагуються ([AGENTS.md](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md)).

## Аліаси імпортів бекенду

Бекенд використовує Node.js subpath imports (`#...`). Вони оголошені двічі: у `imports` [packages/backend/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json) — для рантайму (вказують на `dist/`), і в `compilerOptions.paths` [packages/backend/tsconfig.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/tsconfig.json) — для TypeScript (вказують на `src/`).

| Аліас         | Рантайм (`package.json`)        | TypeScript (`tsconfig.json`) |
| ------------- | ------------------------------- | ---------------------------- |
| `#app/*`      | `./dist/app/*`                  | `./src/app/*`                |
| `#config/*`   | `./dist/config/*`               | `./src/config/*`             |
| `#vendor/*`   | `./dist/vendor/*`               | `./src/vendor/*`             |
| `#database/*` | `./dist/database/*`             | `./src/database/*`           |
| `#logger`     | `./dist/vendor/utils/logger.js` | `./src/vendor/utils/logger`  |
| `#drizzle/*`  | `./dist/drizzle/*`              | `./src/drizzle/*`            |

::: tip
Додаючи новий аліас, оновлюйте обидва місця одночасно. Цілі в `paths` задаються явними відносними шляхами (`./src/...`) — `baseUrl` не використовується.
:::

## Закріплені версії інструментів

Згідно з [AGENTS.md](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md):

- **TypeScript `6.0.3`** — закріплено в корені ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)) і в пакетах (`backend`, `frontend`, `shared`, `api-playground`, `documentation`). Версії слід тримати узгодженими.
- **`@typescript-eslint/*`** утримуються на сумісній з TS 6 лінії через `pnpm.overrides` у кореневому `package.json`; оновлюйте їх разом із `typescript-eslint`.
- **Без `baseUrl`** у `tsconfig` бекенду: він deprecated у TypeScript 6 і перестане працювати в TypeScript 7.
- **`drizzle-orm` і `drizzle-kit` `1.0.0-rc.4`** — release candidate; оновлювати обидва разом до однієї точної версії. Relations — Relational Queries v2 (`defineRelations` у [relations.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/relations.ts)), міграції — у форматі «тека на міграцію» 1.0 ([migrations](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle/migrations)).
- **Node.js `^24.22.2`**, **pnpm `>=9`** (`packageManager: pnpm@9.15.0`).

Детальніше про бекенд — у розділі [Бекенд](/backend/), про команди — у [Скриптах](/reference/scripts).
