# Технічна оцінка `vibe-template`

- **Дата:** 2026-11-23
- **Зріз репозиторію:** `main` @ `015bc2e7`

## Загальний вердикт

**`vibe-template`** — це не типовий starter/boilerplate, а **зріла full-stack платформа** (5 пакетів у pnpm-монорепо, ~87k LOC production-коду та ~102k LOC тестів, 251 виконана фіча в [`feature_list.json`](../feature_list.json)).

За рівнем інженерної дисципліни (контракти, безпека, ізоляція пулів БД, автоматизоване тестування інтеграцій, supply-chain hardening) проєкт **сильно перевершує більшість комерційних репозиторіїв**. Водночас головний його компроміс — **висока архітектурна вага й вартість супроводу**: всередині живе власний міні-фреймворк поверх `uWebSockets.js` (~10.3k LOC), агресивно новий стек залежностей і жорстко вшиті продуктові підсистеми (AI + `pgvector`, SMS-автентифікація, адмінка).

## Зведена оцінка

| Напрям                            |    Оцінка    | Коротко                                                                                          |
| --------------------------------- | :----------: | ------------------------------------------------------------------------------------------------ |
| **Архітектура та контракти**      |  **9 / 10**  | End-to-end типізація HTTP/WS без витоку схем у браузер; примусова шаруватість                    |
| **Безпека та hardening**          | **9.5 / 10** | Системний підхід: MFA/Passkeys, `__Host-` cookies, CSRF, CSP, fail-fast конфіг, digest pinning   |
| **Тестування та CI/CD**           |  **9 / 10**  | Юніт + реальні PG/Redis + Playwright mock/security/CSP/live E2E                                  |
| **DevEx і документація**          | **8.5 / 10** | Єдиний `Makefile`, `doctor.sh`, `api-playground`, двомовна VitePress-дока з `docs:verify`, ADRs  |
| **Фронтенд (UI та бандл)**        |  **7 / 10**  | Чистий клієнтський транспорт, але eager-імпорт адмінки та ~1.65k рядків ручного CSS без UI-кіту  |
| **Observability та Ops**          |  **7 / 10**  | Pino + Sentry + `/ready`, але бракує метрик (Prometheus/OTel) і prod-деплой рецепту (`feat-218`) |
| **Підтримуваність (Maintenance)** | **6.5 / 10** | Кастомний `vendor/` на `uWS` (з патчем), `drizzle-orm` RC, кілька god-файлів >1k LOC             |
| **«Шаблонність» (Адаптивність)**  | **6.5 / 10** | Багато вшитої доменної логіки (21 таблиця, обов'язковий `pgvector`, 3 AI SDK)                    |

## Метрики кодової бази

| Область                                           | Prod-файли | Prod LOC | Тест-файли | Test LOC |
| ------------------------------------------------- | ---------: | -------: | ---------: | -------: |
| `packages/backend/src` (загалом)                  |        399 |   45 324 |        349 |   81 467 |
| └ `packages/backend/src/app`                      |        232 |   29 164 |        208 |   61 386 |
| └ `packages/backend/src/vendor`                   |         85 |   10 307 |         94 |   15 742 |
| └ `packages/backend/src/config`                   |         31 |    2 142 |         21 |    1 513 |
| └ `packages/backend/src/database`                 |         12 |    1 292 |         16 |    1 673 |
| `packages/frontend/src`                           |        126 |   26 630 |         83 |   12 931 |
| `packages/frontend/e2e*` (mock / security / live) |          — |        — |         44 |    5 972 |
| `packages/shared/src`                             |        123 |    6 062 |          — |        — |
| `packages/landing`                                |         33 |    1 974 |          7 |      686 |
| `packages/api-playground/src`                     |         41 |    7 360 |         11 |    1 502 |

---

## 1. Сильні сторони

### 1.1. Контракти та типізація (еталонне рішення)

- Максимально суворий TypeScript 6 (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` у [`tsconfig.base.json`](../tsconfig.base.json)) та `strictTypeChecked` + `stylisticTypeChecked` у [`eslint.config.ts`](../eslint.config.ts).
- **Zero-schema-leak контракти (ADR 0005 / 0006):** [`contract-registry.ts`](../packages/backend/src/app/routing/contract-registry.ts) на рівні компілятора звіряє ArkType-схеми з контрактами `shared/contracts` (`EntryCheck` / `ContractMismatch`), на фронті працює типізований [`api-client.ts`](../packages/frontend/src/utils/api-client.ts), а скрипт [`check-bundle-graph.mjs`](../packages/frontend/scripts/check-bundle-graph.mjs) у `make check` перевіряє Rollup module graph, гарантуючи, що жодна схема валідації чи ArkType не потрапила у клієнтський бандл.
- **Заборона обходу контрактів на рівні лінтера:** у [`packages/frontend/eslint.config.ts`](../packages/frontend/eslint.config.ts) заблоковані прямі `fetch`, `baseApi.http/upload` та `websocketApi`; на бекенді заборонено пряме використання `define-raw-route` та `define-ws-route`.
- **Явна обробка помилок (ADR 0004):** сервіси повертають дискримінований `AppResult<T>` на базі `better-result` ([`errors.ts`](../packages/backend/src/app/services/shared/errors.ts)) замість нетипізованих винятків.

### 1.2. Enforceable архітектура бекенду

- **Тест шаруватості:** [`layering.spec.ts`](../packages/backend/src/app/layering.spec.ts) статично перевіряє межі: контролери, middleware, WebSocket і scheduler не можуть імпортувати репозиторії; сервіси не звертаються напряму до `#database/db.js` чи `#database/schema.js`; `auditEventsRepository` обмежений методами `insert/list/countPurgeable/purgeBatch` (append-only).
- **Ізоляція пулу перевірки сесій (ADR 0002):** [`session-check-db.ts`](../packages/backend/src/database/session-check-db.ts) виділяє окремий `pg.Pool` (`max: 5`) з жорсткими `statement_timeout` і `query_timeout`, щоб повільні бізнес-запити на основному пулі ([`db.ts`](../packages/backend/src/database/db.ts)) не блокували автентифікацію.
- **Продуманий runtime lifecycle:**
    - [`scheduler.ts`](../packages/backend/src/app/scheduler/scheduler.ts) — розподілені джоби з Redis-лізингом, jitter, backoff та обмеженим drain при зупинці.
    - [`user-event-bus.ts`](../packages/backend/src/app/services/communication/user-event-bus.ts) — multi-instance Redis Pub/Sub шина для синхронізації змін профілю/сесій/ролей/step-up MFA між інстансами з фільтрацією власного echo.
    - Коректний graceful shutdown у [`index.ts`](../packages/backend/src/index.ts) із дрейном WS-відключень (`user_online`), flush Sentry і закриттям усіх пулів.

### 1.3. Безпека та supply-chain

- **Fail-fast конфігурація:** [`validate-runtime-config.ts`](../packages/backend/src/app/start/validate-runtime-config.ts) блокує старт у prod-like режимі при небезпечних налаштуваннях (`SESSION_COOKIE_HOST_PREFIX=false`, `Secure=false`, `AUTH_SMS_PROVIDER=fake`, вимкнений LLM-бюджет, відсутні MFA-ключі, перевищення `sun_path` для Unix-сокета тощо).
- **Низькорівневий захист HTTP/Auth:** відсіювання анонімних запитів за HMAC-підписом cookie _до_ буферизації тіла (`signedInBeforeBody` у [`server.ts`](../packages/backend/src/vendor/start/server.ts)), прогрів dummy-хешу пароля на старті проти timing-атак ([`index.ts`](../packages/backend/src/index.ts)), DB `CHECK`-обмеження `users_staff_role_verified_email` ([`schema.ts`](../packages/backend/src/database/schema.ts)), зняття одноразових токенів з URL до навігації ([`router/index.ts`](../packages/frontend/src/router/index.ts)), TOTP + WebAuthn/Passkeys + step-up reauth.
- **Docker & CI hardening:** у [`Dockerfile`](../Dockerfile) базовий образ закріплений за `@sha256`, ключ NodeSource перевіряється по SHA-256 (замість `curl | bash`), контейнер працює від non-root `app`, а `HEALTHCHECK` перевіряє JSON-тіло `/api/ready` (враховуючи, що SPA fallback віддає `200 OK` з `index.html`). У [`ci.yml`](../.github/workflows/ci.yml) і [`audit.yml`](../.github/workflows/audit.yml) всі GitHub Actions закріплені за commit SHA, є щотижневий `pnpm audit --prod`.

### 1.4. Піраміда тестування

- У `packages/backend/src`: **349 тестових файлів (~81.5k рядків)** проти 399 production-файлів (~45.3k рядків).
- Тестування не обмежується моками: окремі CI-пайплайни для реального PostgreSQL+pgvector ([`pg-tests.yml`](../.github/workflows/pg-tests.yml)), реального Redis з Lua-скриптами та `CLIENT PAUSE` ([`redis-tests.yml`](../.github/workflows/redis-tests.yml)), Playwright mock E2E, security/CSP E2E та **live E2E** (реальний SPA + backend + PG + Redis + WebAuthn).

---

## 2. Слабкі сторони, ризики та технічний борг

### 2.1. Власний фреймворк поверх `uWebSockets.js` (`vendor/` — 85 файлів, 10.3k LOC)

Це головний довгостроковий ризик проєкту. Замість Fastify/Hono тут реалізовано власний HTTP-роутер, парсер тіла/multipart, статичний сервер із in-memory Brotli/Gzip кешем ([`static-server.ts`](../packages/backend/src/vendor/start/static-server.ts)), middleware pipeline, WS-фреймінг, rate limiter і сесійний механізм.

- **Наслідки:** високий bus-factor і поріг входу для нових розробників. `uWebSockets.js` підключений з GitHub tag (`github:uNetworking/uWebSockets.js#v20.71.0`), прив'язаний до нативного ABI конкретної версії Node (`24.22.2`), уже вимагає ручного патчу ([`uWebSockets.js@20.71.0.patch`](../patches/uWebSockets.js@20.71.0.patch)) і має нестандартні edge-cases (наприклад, тихе обрізання не-ASCII байтів на краях HTTP-заголовків, зафіксоване в [`security-review-2026-11-12-follow-ups.md`](./security/security-review-2026-11-12-follow-ups.md)).
- Для типового SaaS/CRM-продукту виграш у мікросекундах від `uWS` рідко перекриває вартість підтримки власного веб-фреймворку, якщо тільки продукт не планує тримати десятки тисяч одночасних WebSocket-з'єднань на один процес.

### 2.2. Bleeding-edge залежності

У [`package.json`](../package.json) та [`packages/backend/package.json`](../packages/backend/package.json):

- `drizzle-orm` і `drizzle-kit` зафіксовані на **`1.0.0-rc.5`** (release candidate з міграцією на Relational Queries v2).
- `typescript@6.0.3` з `pnpm.overrides` для `@typescript-eslint/*`, `eslint@10`, `vite@7` з окремим override `vitepress>vite: ^6.4.5`, `vue-router@5`, `pinia@4`.
- Це знижує стабільність екосистеми сторонніх бібліотек, які команда захоче підключити після форку шаблону.

### 2.3. Великі монолітні файли (God-modules)

Попри хорошу декомпозицію директорій, частина критичних модулів розрослася:

- **Backend:** [`auth-service.ts`](../packages/backend/src/app/services/auth/auth-service.ts) (1 385 рядків), [`oauth-service.ts`](../packages/backend/src/app/services/auth/oauth-service.ts) (1 114), [`mfa-sign-in.ts`](../packages/backend/src/app/services/auth/mfa/mfa-sign-in.ts) (874), [`request-session.ts`](../packages/backend/src/vendor/utils/session/request-session.ts) (866), [`server.ts`](../packages/backend/src/vendor/start/server.ts) (812), [`http-routes.ts`](../packages/backend/src/app/routes/http-routes.ts) (782), [`ws-handlers.ts`](../packages/backend/src/vendor/utils/network/ws-handlers.ts) (765).
- **Frontend:** [`UserAccount.vue`](../packages/frontend/src/views/UserAccount.vue) (1 206 рядків), [`SupportView.vue`](../packages/frontend/src/views/SupportView.vue) (841), [`AdminKnowledgeBaseView.vue`](../packages/frontend/src/views/admin/AdminKnowledgeBaseView.vue) (765), [`styles.css`](../packages/frontend/src/styles.css) (898) + [`shared-components.css`](../packages/frontend/src/shared-components.css) (753).

### 2.4. Фронтенд: code splitting, i18n і CSS-архітектура

- **Eager-імпорт адмінки та важких views:** у [`packages/frontend/src/router/index.ts`](../packages/frontend/src/router/index.ts) статично імпортуються `AdminLayout`, `AdminKnowledgeBaseView`, `AdminUsersView`, `AdminUserOnlineView`, `AdminHistoryOnlineView`, `SupportView`, `UserAccount` — лише `NotificationsView`, `AdminAuditLogView` та legal-сторінки завантажуються ліниво (`() => import(...)`). Кожен неавторизований гість на `/login` завантажує код адмін-панелі.
- **Runtime-компілятор i18n у бандлі:** у [`packages/frontend/vite.config.ts`](../packages/frontend/vite.config.ts) увімкнено `__INTLIFY_JIT_COMPILATION__: true` і `__INTLIFY_DROP_MESSAGE_COMPILER__: false` — клієнтський бандл несе компілятор повідомлень замість прекомпіляції на етапі збірки.
- **Відсутність єдиного UI-шару:** основний `frontend` написаний на ~1 650 рядках ручного глобального CSS (без headless UI-примітивів для складних діалогів/меню/фокус-трепів), тоді як [`api-playground/package.json`](../packages/api-playground/package.json) використовує Tailwind CSS v3.

### 2.5. Надмірна зв'язаність шаблону з доменними фічами

- **Обов'язковий `pgvector`:** [`schema.ts`](../packages/backend/src/database/schema.ts) містить `vector(1536)` для бази знань підтримки; без розширення `pgvector` початкова міграція падає навіть у продуктах без AI.
- **3 AI SDK у production-залежностях** (`openai`, `@mistralai/mistralai`, `ai` + `@ai-sdk/xai` у [`packages/backend/package.json`](../packages/backend/package.json)): зокрема `@mistralai/mistralai` вже притягував транзитивні CVE через MCP SDK (`hono` / `@hono/node-server`), які довелося латати через `pnpm.overrides`.
- **21 таблиця та 22 міграції** «з коробки»: якщо ви робите продукт без AI-сапорту або phone-auth, вирізання цих модулів потребуватиме правок у БД, контрактах, роутах, перекладах та тестах.
- Дрібний дрейф схеми: [`relations.ts`](../packages/backend/src/database/relations.ts) не описує зв'язки для новіших таблиць (`totp_factors`, `mfa_recovery_codes`, `webauthn_credentials`, `audit_events`).

### 2.6. Observability та прогалини для production-експлуатації

- **Немає runtime-метрик (Prometheus / OpenTelemetry):** є якісне логування (Pino) та error tracking (Sentry), але немає числових метрик по HTTP/WS latency, утилізації `pool` / `sessionCheckPool`, кількості активних WS-з'єднань, спрацювань rate limiter та результатів scheduler-джобів.
- **Неповна верифікація OAuth і prod-деплою:** OAuth-потоки з PKCE та `email_verified` перевірені лише на моках, але не на живих Google/GitHub/GitLab ([`security-review-2026-11-12-follow-ups.md`](./security/security-review-2026-11-12-follow-ups.md)); `feat-218` (_Production Compose And Dokploy Deployment_) лишається `not-started`.
- **Масштабування WebSocket:** `user-event-bus.ts` коректно реплікує 4 user-події і 2 server-події через Redis, але `broadcastToChannel` ([`server.ts`](../packages/backend/src/vendor/start/server.ts)) публікує лише в локальний `uWS` процес — при запуску >1 репліки бекенду потрібно враховувати, які канали проходять через Redis, а які локальні.

---

## 3. Пріоритетні рекомендації

1. **Lazy-loading маршрутів фронтенду (quick win):** перевести `Admin*`, `SupportView` і `UserAccount` у [`router/index.ts`](../packages/frontend/src/router/index.ts) на динамічні імпорти `() => import(...)`, а також розглянути `@intlify/unplugin-vue-i18n` для pre-compilation перекладів.
2. **Декомпозиція god-файлів:** розбити [`auth-service.ts`](../packages/backend/src/app/services/auth/auth-service.ts) на окремі модулі (`email-auth`, `phone-auth`, `account-linking`, `password-service`), а [`UserAccount.vue`](../packages/frontend/src/views/UserAccount.vue) — на секційні компоненти.
3. **Додати метрики (OTel або Prometheus):** експонувати базові метрики пулів PG, Redis, HTTP/WS та scheduler на внутрішньому/захищеному ендпоінті.
4. **Закрити відкриті operational-хвости:** прогнати OAuth на реальних провайдерах (Google/GitHub/GitLab), довести до `done` `feat-218` (production deployment) та синхронізувати [`relations.ts`](../packages/backend/src/database/relations.ts) зі `schema.ts`.
5. **Опціональність AI/pgvector (стратегічно):** якщо шаблон планується перевикористовувати для різних продуктів, варто відділити AI-сапорт і `pgvector` в окремий feature-модуль (або задокументувати чіткий чеклист/скрипт видалення) і прибрати зайві AI SDK, які дублюють Vercel `ai` SDK.
6. **Стабілізація стеку:** мігрувати `drizzle-orm` / `drizzle-kit` з `1.0.0-rc.5` на стабільний `1.0.0` після релізу та прибрати патч `uWebSockets.js`, коли апстрім пофіксить ESM wrapper.

---

## Кому цей шаблон підходить

- **Ідеально:** для SaaS / B2C-продукту або адмін-платформи, де одразу потрібні надійний auth (з MFA/Passkeys/OAuth/SMS), real-time WebSocket, PWA + Push, сувора безпека та готова інфраструктура тестів — і команда готова підтримувати `uWebSockets.js` + строгий TypeScript.
- **Не оптимально:** для MVP «за вихідні», простих CRUD-сервісів без real-time/AI або команд без досвіду глибокого TypeScript, де кастомний `vendor/` та суворі контракти сповільнять старт замість прискорення.
