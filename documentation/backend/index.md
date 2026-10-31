# Огляд бекенду

::: tip Вперше тут?
Ця сторінка — технічний огляд. Якщо ви тільки знайомитеся з шаблоном, почніть з [Як влаштований бекенд](/guide/how-backend-works): там простими словами пояснено шлях запиту і навіщо потрібні шари.
:::

Пакет `backend` ([packages/backend](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend)) — HTTP- та WebSocket-сервер на TypeScript (ES modules), побудований на uWebSockets.js. Точка входу — [src/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/index.ts); у розробці він запускається через `tsx watch`, у продакшені — як `node dist/index.js` (див. [Скрипти](/reference/scripts)).

## Стек

За залежностями з [packages/backend/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json):

| Призначення           | Залежності                                                    |
| --------------------- | ------------------------------------------------------------- |
| HTTP/WebSocket-сервер | `uWebSockets.js` (`v20.71.0` з GitHub), `ws`                  |
| БД                    | `drizzle-orm` / `drizzle-kit` `1.0.0-rc.4`, `pg` (PostgreSQL) |
| Валідація             | `@arktype/type`                                               |
| Redis                 | `ioredis`                                                     |
| Моніторинг і логи     | `@sentry/node`, `pino`, `pino-pretty`                         |
| Файлове сховище       | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`         |
| Пошта                 | `nodemailer`                                                  |
| Push-сповіщення       | `web-push`                                                    |
| AI                    | `ai`, `@ai-sdk/xai`, `openai`, `@mistralai/mistralai`         |
| OAuth                 | `arctic`                                                      |
| Утиліти               | `better-result`, `dotenv`, `luxon`, `metautil`, `nanoid`      |
| Контракти             | `shared` (`workspace:*`)                                      |

Тести — Vitest, збірка — `tsc --build` з посиланням на `../shared` ([tsconfig.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/tsconfig.json)).

## Структура `src`

| Каталог                                                                                                | Вміст                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [app](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app)                   | Логіка застосунку: `controllers` (http, ws), `middlewares`, `repositories`, `transformers`, `services`, `routes` (`http-routes.ts`, `ws-routes.ts`), `routing` (`define-route.ts`, `define-ws-route.ts`), `start`, `state`, `validate`, `websocket` |
| [config](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config)             | Модулі конфігурації: `app`, `auth`, `cookies`, `cors`, `csp`, `csrf`, `database`, `redis`, `session`, `mail`, `disk`, `push`, `ai`, `oauth`, `sentry` та ін.                                                                                        |
| [vendor](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor)             | Інфраструктурне ядро: `start/` (`server.ts`, `router.ts`, `static-server.ts`), `utils/` (logger, session, rate-limit, storage, validation…), `contracts/`, `types/`                                                                                 |
| [database](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database)         | Підключення (`db.ts`, `redis.ts`), схема (`schema.ts`) і relations (`relations.ts`)                                                                                                                                                                 |
| [db](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/db)                     | Скрипти `create-database.ts` і `seed.ts`                                                                                                                                                                                                            |
| [drizzle](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle)           | Міграції (`migrations/`, по одній папці на міграцію)                                                                                                                                                                                                |
| [openapi](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/openapi)           | Невикористані заготовки під OpenAPI (`spec.ts` порожній)                                                                                                                                                                                            |
| [test-support](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/test-support) | Хелпери для тестів: тимчасова база PostgreSQL, тестовий Redis, фікстури зображень                                                                                                                                                                   |
| [scripts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts)           | Службові скрипти, зокрема `send-test-email.ts`                                                                                                                                                                                                      |

### Дерево каталогів

Тести (`*.spec.ts`, `*.test.ts`) лежать поруч з кодом і в дереві не показані.

```text
packages/backend/src/
├── index.ts                  # точка входу: старт сервера, graceful shutdown
├── sentry-bootstrap.ts       # ініціалізація Sentry до решти імпортів
├── app/                      # логіка застосунку (ваш код)
│   ├── routes/               # таблиці маршрутів
│   │   ├── http-routes.ts    #   HTTP: метод, шлях, middleware, схеми, контролер
│   │   └── ws-routes.ts      #   WebSocket-події
│   ├── routing/              # define-route.ts, define-ws-route.ts — хелпери оголошення маршрутів
│   ├── middlewares/          # kernel.ts (реєстр), csrf-guard, admin-guard, ws-admin-guard
│   ├── controllers/          # тонкий шар: дістає дані із запиту, кличе сервіс, віддає відповідь
│   │   ├── http/             #   admin, ai, auth, core, notifications, support, user
│   │   ├── ws/               #   admin-ws-controller, support-controller
│   │   └── shared/           #   controller-error.ts
│   ├── services/             # бізнес-логіка, по папці на домен
│   │   ├── auth/             #   вхід, OAuth, підтвердження пошти, скидання пароля, throttle
│   │   ├── user/             #   аватар, ролі
│   │   ├── admin/            #   користувачі й онлайн для адмін-панелі
│   │   ├── ai/               #   провайдери (adapters/: OpenAI, xAI, Mistral), промпти, облік токенів
│   │   ├── support/          #   AI-чат підтримки і база знань (pgvector)
│   │   ├── notifications/    #   пошта, Web Push, підписки
│   │   ├── communication/    #   broadcast, хто онлайн, WS-presence
│   │   ├── core/             #   main-service (init), readiness для /ready
│   │   ├── statistics/       #   статистика push-підписок
│   │   ├── observability/    #   sentry-service
│   │   ├── actions/          #   ToolDefinition — опис інструментів для AI
│   │   └── shared/           #   помилки, result-хелпери, доступ до сесії
│   ├── repositories/         # єдиний шар, що ходить у БД (Drizzle)
│   │   ├── auth/  user/  ai/  support/  notifications/  communication/  health/
│   │   └── index.ts
│   ├── transformers/         # рядок БД → об'єкт відповіді (user, push-subscription)
│   ├── validate/             # валідація запитів
│   │   ├── adapters/         #   arktype-adapter
│   │   ├── checkers/         #   cookie, header, parameter
│   │   ├── schemas/          #   common/, query/
│   │   └── errors/           #   validation-error.ts
│   ├── websocket/            # реєстр з'єднань, координатор, авторизація WS-сесії
│   ├── state/                # state.ts — спільний стан процесу (listenSocket)
│   └── start/                # index.ts, validate-runtime-config.ts — перевірка конфігу на старті
├── config/                   # по модулю на підсистему: app, auth, cors, csp, csrf, database,
│                             #   redis, session, mail, disk, push, ai, oauth, sentry, rate-limit…
├── vendor/                   # інфраструктурне ядро шаблону, зазвичай не змінюється
│   ├── start/                #   server.ts, router.ts, static-server.ts, validators.ts
│   ├── utils/                #   context, env, helpers, middlewares, network, rate-limit,
│   │                         #   routing, session, storage (S3), tooling, validation, logger.ts
│   ├── contracts/            #   validator.ts — інтерфейс валідатора
│   ├── constants/            #   спільні константи, mime-types
│   └── types/                #   types.d.ts
├── database/                 # db.ts, redis.ts, schema.ts (таблиці), relations.ts
├── drizzle/
│   └── migrations/           # згенеровані drizzle-kit, папка на міграцію
├── db/                       # create-database.ts, seed.ts, seed/
├── scripts/                  # службові скрипти (send-test-email.ts)
├── test-support/             # тимчасова БД, тестовий Redis, фікстури
└── openapi/                  # невикористані заготовки
```

Новий домен додається однаково: файл у `repositories/<домен>/`, за потреби `transformers/`, сервіс у `services/<домен>/`, контролер у `controllers/http/<домен>/` і рядок у `routes/http-routes.ts`. Покроково — [Додавання фічі](/backend/adding-a-feature).

Модулі імпортуються через аліаси `#app/*`, `#config/*`, `#vendor/*`, `#database/*`, `#drizzle/*` та `#logger` — див. [Структура проєкту](/guide/project-structure).

Бізнес-логіка розкладена шарами `repository → transformer → service → controller → route`, а контракти запитів/відповідей описуються в `shared` ([README.md](https://github.com/Blazheiko/vibe-template/blob/main/README.md)).

## Куди далі

- [Архітектура](/backend/architecture)
- [Життєвий цикл запиту](/backend/request-lifecycle)
- [Конфігурація](/backend/configuration)
- [Маршрутизація](/backend/routing)
- [Middleware](/backend/middlewares)
- [База даних](/backend/database)
- [Автентифікація](/backend/auth)
- [Вхід через соцмережі](/backend/oauth)
- [Безпека](/backend/security)
- [Додавання фічі](/backend/adding-a-feature)
