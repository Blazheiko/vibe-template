# Проблеми в коді, знайдені під час написання документації (feat-003)

Знайдено під час написання сторінок v1 (feat-003). Перевірено читанням коду та прогоном на чистому клоні.
Під час feat-003 нічого не виправлялося; пункти закриваються окремими фічами. Кожен відкритий пункт — кандидат на запис у `feature_list.json` або issue.

**Стан на 2026-10-24.** Виправлені пункти позначено в тексті рядком «Виправлено»:

| Фіча     | Пункти         |
| -------- | -------------- |
| feat-005 | 1, 2, 3, 9     |
| feat-006 | 4, 5, 6, 8, 31 |
| feat-007 | 7, 10, 11      |
| feat-008 | 12, 13, 14     |
| feat-009 | 15, 69         |
| feat-012 | 65             |
| feat-014 | 60             |
| feat-016 | 70             |
| feat-010 | 16             |
| feat-018 | 36, 37, 38     |
| feat-021 | 47, 48, 67     |
| feat-022 | 20, 21, 49     |
| feat-025 | 22, 24, 25     |
| feat-026 | 26, 27         |
| feat-019 | 28, 29, 30     |
| feat-020 | 18, 42         |
| feat-023 | 32, 44, 45, 46 |
| feat-024 | 17, 19         |
| feat-027 | 23, 50, 51     |
| feat-028 | 53             |
| feat-029 | 43, 52, 54     |
| feat-030 | 33, 34, 35     |
| feat-031 | 39, 40, 41     |
| feat-032 | 56, 57, 58     |
| feat-033 | 59, 61, 62–64  |
| feat-034 | 66             |
| feat-035 | 68             |
| feat-038 | 71, 72, 73     |

Усі 49 пунктів плану закрито. П. 55 — **відкладено** (рішення Р3: тестовий застосунок, промпти поки не очищаються). Пункти 71–73, знайдені під час виконання плану, закрито у feat-038. План закриття: [`open-issues-roadmap.md`](./open-issues-roadmap.md), task list: [`open-issues-tasks.md`](./open-issues-tasks.md).

Шляхи відносно `packages/backend/`, якщо не вказано інше.

## Зведення

| #   | Проблема                                                                                                          | Серйозність  | Область                      |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| 1   | ~~CSP ніде не застосовується~~ ✅                                                                                 | Висока       | Безпека                      |
| 2   | ~~Немає rate limit на WebSocket upgrade і глобального per-IP ліміту~~ ✅                                          | Висока       | Безпека                      |
| 3   | ~~WS-токен і `userToken` потрапляють у логи~~ ✅                                                                  | Середня      | Безпека                      |
| 4   | ~~`SERVE_STATIC=true` у `.env.example` ламає запуск~~ ✅                                                          | Середня      | DX / конфігурація            |
| 5   | ~~Fallback `PGSQL_PORT` не працює → `NaN`~~ ✅                                                                    | Середня      | Конфігурація                 |
| 6   | ~~Розбіжності `.env.example` з кодом~~ ✅                                                                         | Середня      | Конфігурація                 |
| 7   | ~~Потрібен pgvector, ніде не задокументовано~~ ✅                                                                 | Низька       | DX / БД                      |
| 8   | ~~Різні PostgreSQL defaults у застосунку та скриптах~~ ✅                                                         | Низька       | Конфігурація                 |
| 9   | ~~`broadcastToChannel` без runtime-перевірки каналу (L-4)~~ ✅                                                    | Низька       | Безпека                      |
| 10  | ~~`db:seed` — порожня заглушка~~ ✅                                                                               | Низька       | DX / БД                      |
| 11  | ~~`src/drizzle/schema/index.ts` порожній~~ ✅                                                                     | Низька       | Структура                    |
| 12  | ~~Тіло запиту читається лише для `post`/`put`~~ ✅                                                                | Низька       | HTTP                         |
| 13  | ~~`sendResponse` при `payload === null` віддає `String(status)` як JSON~~ ✅                                      | Низька       | HTTP                         |
| 14  | ~~Прогалини плану body limits: тести, `.env.example`, playground~~ ✅                                             | Низька       | HTTP / тести                 |
| 15  | ~~Застарілі внутрішні документи~~ ✅                                                                              | Низька       | Документація                 |
| 16  | ~~Стиль коду бекенду не відповідає `AGENTS.md`~~ ✅                                                               | Інформаційна | Стиль                        |
| 17  | ~~Фронтенд вшиває префікс `api/` у WS-події~~ ✅                                                                  | Середня      | WebSocket / frontend         |
| 18  | ~~WS upgrade без валідної сесії не відхиляється~~ ✅                                                              | Низька       | WebSocket / безпека          |
| 19  | ~~Мертвий код у WebSocket-шарі~~ ✅                                                                               | Низька       | WebSocket / структура        |
| 20  | ~~Сервіси push-нотифікацій звертаються до БД напряму~~ ✅                                                         | Середня      | Шари / БД                    |
| 21  | ~~N+1 у `findByUserIdWithLogs` і статистика в JS~~ ✅                                                             | Середня      | Продуктивність               |
| 22  | ~~Контролери та middleware оминають сервіси~~ ✅                                                                  | Низька       | Шари                         |
| 23  | ~~`prompt-controller` сам викликає OpenAI і кидає `Error`~~ ✅                                                    | Середня      | Шари / помилки               |
| 24  | ~~Repositories barrel неповний, змішані стилі імпорту~~ ✅                                                        | Низька       | Структура                    |
| 25  | ~~`clearEmbedding` — два запити без транзакції, сирий SQL з назвами~~ ✅                                          | Низька       | БД                           |
| 26  | ~~ArkType-адаптер віддає лише `summary`, без помилок по полях~~ ✅                                                | Низька       | Валідація                    |
| 27  | ~~Мертвий і застарілий код валідації та контролерів~~ ✅                                                          | Низька       | Структура                    |
| 28  | ~~Немає `.dockerignore`~~ ✅                                                                                      | Середня      | Docker / безпека             |
| 29  | ~~Контейнер працює від root, без `HEALTHCHECK`~~ ✅                                                               | Середня      | Docker / безпека             |
| 30  | ~~`CMD` через `sh -c`: міграції на кожному старті, сигнали~~ ✅                                                   | Середня      | Docker / експлуатація        |
| 31  | ~~Образ не вмикає `SERVE_STATIC` і не задає `APP_ENV`~~ ✅                                                        | Низька       | Docker / конфігурація        |
| 32  | ~~`corsS3.xml`: `AllowedOrigin *` разом з `PUT`~~ ✅                                                              | Середня      | Безпека / S3                 |
| 33  | ~~`handleError` логує без `requestId`, контекст без `userId`~~ ✅                                                 | Низька       | Observability                |
| 34  | ~~Рівень логування не налаштовується (`LOG_LEVEL` немає)~~ ✅                                                     | Низька       | Observability                |
| 35  | ~~Немає readiness-перевірки (DB/Redis)~~ ✅                                                                       | Середня      | Observability / експлуатація |
| 36  | ~~Немає CI для тестів застосунку і coverage~~ ✅                                                                  | Середня      | Тести / CI                   |
| 37  | ~~`vitest.config.ts` без `testTimeout`, таймаути під навантаженням~~ ✅                                           | Низька       | Тести                        |
| 38  | ~~Playwright `webServer` використовує `npm` у pnpm-workspace~~ ✅                                                 | Низька       | Тести / frontend             |
| 39  | ~~Річний `immutable` для всіх не-HTML файлів, зокрема без хешу~~ ✅                                               | Середня      | Кешування                    |
| 40  | ~~`If-None-Match` порівнюється як точний рядок~~ ✅                                                               | Низька       | Кешування                    |
| 41  | ~~Статика повністю в RAM без стиснення і ліміту~~ ✅                                                              | Низька       | Продуктивність               |
| 42  | ~~API JSON без `Cache-Control: no-store`~~ ✅                                                                     | Середня      | Кешування / безпека          |
| 43  | ~~Кеш промптів у пам'яті процесу без TTL~~ ✅                                                                     | Низька       | Кешування / AI               |
| 44  | ~~`deleteFromS3` без `buildKey`, логіка префікса в трьох місцях~~ ✅                                              | Низька       | Сховище                      |
| 45  | ~~Аватари без `public-read`, але читаються напряму через CDN~~ ✅                                                 | Низька       | Сховище                      |
| 46  | ~~MIME-тип довіряється заголовку клієнта~~ ✅                                                                     | Середня      | Сховище / безпека            |
| 47  | ~~Підписка push перепризначається іншому користувачу за endpoint~~ ✅                                             | Низька       | Push / безпека               |
| 48  | ~~`GET /test-push` з побічними ефектами (оминає CSRF)~~ ✅                                                        | Низька       | Push / безпека               |
| 49  | ~~Push надсилається лише з `test-push`, послідовно без батчів~~ ✅                                                | Низька       | Push                         |
| 50  | ~~Невідомий `AI_TEXT_DRIVER` мовчки дає Mistral~~ ✅                                                              | Низька       | AI / конфігурація            |
| 51  | ~~Виклики AI-провайдерів без timeout/`AbortSignal`~~ ✅                                                           | Середня      | AI / надійність              |
| 52  | ~~Support AI: `langNative = 'ru'` зашито в коді~~ ✅                                                              | Середня      | AI / i18n                    |
| 53  | ~~Неповний облік використання AI (переклад, тест промпту, embeddings, Mistral без usage)~~ ✅                     | Низька       | AI                           |
| 54  | ~~Embeddings: `vector(1536)` зашито, `reindexAll` без батчів, пошук без порогу~~ ✅                               | Низька       | AI / БД                      |
| 55  | ~~`llm_text_usage.final_prompt` безстроково зберігає повні тексти (PII)~~ ✅                                      | Середня      | AI / приватність             |
| 56  | ~~Тест shared не містить жодного тесту (`pass 1` — порожній файл)~~ ✅                                            | Середня      | Тести / shared               |
| 57  | ~~`guards` у shared порожні й закоментовані в `index.ts`~~ ✅                                                     | Низька       | shared                       |
| 58  | ~~`EntityIdSchema` без `.brand()` — не брендований тип~~ ✅                                                       | Низька       | shared                       |
| 59  | ~~Фронтенд: fallback `VITE_BASE_URL` на `https://vibe-template.example`~~ ✅                                      | Середня      | Frontend / DX                |
| 60  | ~~Фронтенд: `console.log(data)` друкує відповідь init з `wsToken`~~ ✅                                            | Середня      | Frontend / безпека           |
| 61  | ~~Фронтенд: нетипізовані `VITE_*` змінні, застарілі коментарі~~ ✅                                                | Низька       | Frontend                     |
| 62  | ~~Playground: `/api/doc/routes` зашито, ігнорує `baseUrl` і `API_PATH_PREFIX`~~ ✅                                | Низька       | Playground                   |
| 63  | ~~Playground: `https://` → `ws://` замість `wss://`~~ ✅                                                          | Низька       | Playground                   |
| 64  | ~~Playground: «message queued», хоча повідомлення відкидається~~ ✅                                               | Низька       | Playground                   |
| 65  | ~~`POST /main/save-user`: анонімне створення користувача з паролем у відкритому тексті~~ ✅ виправлено (feat-012) | **Критична** | Безпека                      |
| 66  | ~~`users.isAdmin` — мертве поле поруч із `role`~~ ✅                                                              | Низька       | БД / ролі                    |
| 67  | ~~Push-група без `auth_guard`, перевірка в контролері~~ ✅                                                        | Низька       | Безпека / ролі               |
| 68  | ~~ESLint `strictTypeChecked` фактично вимкнено для backend/frontend/playground~~ ✅                               | Низька       | Toolchain                    |
| 69  | ~~`AGENTS.md`: застаріле «checkout does not include .git history»~~ ✅                                            | Інформаційна | Документація                 |
| 70  | ~~Основний Redis-клієнт без таймауту: при недоступному Redis запити чекають ~45 с~~ ✅                            | Середня      | Надійність / Redis           |
| 71  | ~~`format:check` не перевіряє `.vue`, `.js`, `.mjs`, `.css`~~ ✅                                                  | Низька       | Стиль                        |
| 72  | ~~Push не надсилається жодною бізнес-подією~~ ✅                                                                  | Низька       | Push                         |
| 73  | ~~HTTP-виклики фронтенду вшивають `/api/`~~ ✅                                                                    | Низька       | Frontend                     |

## Безпека

### 1. CSP ніде не застосовується

> **Виправлено** у feat-005 (гілка `feat/security-hardening`) за планом [`csp-fix-plan.md`](./csp-fix-plan.md).

- **Що:** конфіг `src/config/csp.ts` ніхто не імпортує. Код встановлення CSP у `src/vendor/start/static-server.ts` закоментовано. `setSecurityHeaders` у `src/vendor/start/server.ts` додає `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` і HSTS, але `Content-Security-Policy` не додає.
- **Наслідок:** жодна відповідь (API, статика, HTML) не має CSP. Це finding M-5 зі `SECURITY_ANALYSIS.md`, закритий лише частково.
- **Пропозиція:** підключити `config/csp.ts` у `setSecurityHeaders` і в static handler; додати тест на наявність заголовка.

### 2. Немає rate limit на WebSocket upgrade і глобального per-IP ліміту

> **Виправлено** у feat-005 (гілка `feat/security-hardening`) за планом [`ws-upgrade-rate-limit-plan.md`](./ws-upgrade-rate-limit-plan.md): L1 per-IP для HTTP API, окремий ліміт upgrade, лічильник з обмеженою пам'яттю. Підзадачу для кількох інстансів закрито у feat-013 за планом [`redis-rate-limit-plan.md`](./redis-rate-limit-plan.md): HTTP і WS-повідомлення свідомо лишаються в пам'яті (захист процесу), WS upgrade отримав другий рівень у Redis, а чутливі auth-дії (зокрема вхід, зміна й скидання пароля) обмежує спільний реєстр `config/throttle-policies.ts`. Поки що замість нього рекомендовано edge-ліміт у nginx, його описано в `deployment.md`.

- **Що:** rate limiting є лише per-route для HTTP (`src/vendor/utils/rate-limit/*`), перевірка виконується до читання body. Upgrade-запит WebSocket ліміту не має. Глобального L1-ліміту за IP також немає. Лічильник зберігається в пам'яті процесу, а не в Redis.
- **Наслідок:** при кількох інстансах ліміт не спільний. Upgrade можна флудити. Це залишок finding C-2.
- **Пропозиція:** додати ліміт на `upgrade` за IP (`src/vendor/utils/rate-limit/ws-rate-limit.ts` або в `handleUpgrade`), розглянути Redis-лічильник для multi-instance.

### 3. WS-токен і `userToken` потрапляють у логи

> **Виправлено** у feat-005 (гілка `feat/security-hardening`): хелпер `maskTokenForLogs` (`src/vendor/utils/helpers/mask-sensitive.ts`) лишає в логах лише префікс `abcd…`. Його застосовано в `verifyUpgradeToken` (WS-токен; замість `sessionKey` логуються `sessionId` і маскований `userToken`), `wsSessionHandler` (`userToken`) `verifyToken` у `token-handler.ts` (`cookieUserToken`; підпис більше не логується) і `destroyAllSessions` у `redis-session-storage.ts` (`userToken`; Redis-pattern більше не логується). `parseCookies` при помилці декодування більше не друкує весь заголовок `Cookie`. Префікс із 4 символів годиться для локального зіставлення разом із `sessionId`, але не унікальний; для кореляції в масштабі потрібен стабільний HMAC-fingerprint (не зроблено).

- **Що:** `verifyUpgradeToken` логує WS-токен; `wsSessionHandler` логує `userToken`.
- **Наслідок:** секрети сесії потрапляють у логи та Sentry breadcrumbs.
- **Пропозиція:** прибрати значення з логів або маскувати (`abcd…`).

### 9. `broadcastToChannel` без runtime-перевірки каналу

> **Виправлено** у feat-005: whitelist `WS_CHANNELS` і guard `isWsChannel` у `packages/shared/src/guards/ws-channels.ts` (без залежностей); `broadcastToChannel` приймає `WsChannel` і в runtime відкидає невідомі канали з `warn`. Заодно `shared/guards` перестав бути порожнім (частково п. 57).

- **Що:** `broadcastToChannel(channel: string, …)` приймає будь-який рядок, перевірка є лише на рівні типів. Finding L-4 зі `SECURITY_ANALYSIS.md` досі відкритий.
- **Пропозиція:** whitelist/шаблон допустимих каналів або перевірка формату перед publish.

## Конфігурація та запуск

### 4. `SERVE_STATIC=true` у `.env.example` ламає запуск

> **Виправлено** у feat-006 (гілка `feat/env-example-sync`): у `.env.example` `SERVE_STATIC=false`; без каталогу `public` `cacheStaticSource` пише `logger.warn` і сервер стартує без статики; `Dockerfile` задає `SERVE_STATIC=true` і `APP_ENV=production` (закриває і п. 31).

- **Що:** `.env.example` містить `SERVE_STATIC=true`. Тоді бекенд на старті сканує `packages/backend/public`, якого в репозиторії немає, і падає. Default у коді — `false` (`src/config/app.ts`).
- **Відтворення:** чистий клон → `cp .env.example .env` → `pnpm dev`, результат — `ENOENT: no such file or directory, scandir '.../packages/backend/public'`.
- **Пропозиція:** у `.env.example` поставити `SERVE_STATIC=false` або обробляти відсутність каталогу (warning замість падіння).

### 5. Fallback `PGSQL_PORT` не працює

> **Виправлено** у feat-006: `resolveDatabaseConfig()` у `src/config/database.ts` дає порт `5432`, коли `PGSQL_PORT` не задано або порожній, а на невалідне значення кидає помилку на старті.

- **Що:** у `src/config/database.ts` написано `Number(env["PGSQL_PORT"]) ?? 5432`. `Number(undefined)` повертає `NaN`, а не `null`/`undefined`, тому `??` ніколи не спрацьовує.
- **Наслідок:** без `PGSQL_PORT` застосунок отримує порт `NaN`.
- **Пропозиція:** `Number(env["PGSQL_PORT"] ?? 5432)` або парсинг з перевіркою.

### 6. Розбіжності `.env.example` з кодом

> **Виправлено** у feat-006: `.env.example` синхронізовано з кодом. Прибрано `UNIX_PATH` (замінено на `APP_UNIX_PATH`), `DATABASE_URL`, `TELEGRAM_*`, `XAI_IMAGE_*`; додано `API_PATH_PREFIX`, `APP_MAX_*_BODY_SIZE`, OAuth-змінні, `AI_TEXT_DRIVER`, `MISTRAL_*`, `TURN_*`; `REDIS_PREFIX` = `uwebsocket:`. `NODE_ENV` навмисно не додано (запасне джерело для `APP_ENV`). `config/turn.ts` поки ніхто не імпортує.

- **Є в `.env.example`, але код не читає (8):** `UNIX_PATH` (код читає `APP_UNIX_PATH`), `DATABASE_URL` (діють `PGSQL_*`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `XAI_IMAGE_API_URL`, `XAI_IMAGE_EDIT_API_URL`, `XAI_IMAGE_MODEL`, `XAI_IMAGE_FORMAT`.
- **Код читає, але немає в `.env.example` (26):** `AI_TEXT_DRIVER`, `API_PATH_PREFIX`, `APP_MAX_BODY_SIZE`, `APP_MAX_JSON_BODY_SIZE`, `APP_MAX_MULTIPART_BODY_SIZE`, `APP_MAX_OCTET_BODY_SIZE`, `APP_UNIX_PATH`, по три змінні `CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI` для `GOOGLE_`, `FACEBOOK_`, `GITHUB_`, `GITLAB_` (12), `OAUTH_FRONTEND_SUCCESS_URL`, `OAUTH_FRONTEND_ERROR_URL`, `MISTRAL_API_KEY`, `MISTRAL_TEXT_MODEL`, `NODE_ENV`, `TURN_SECRET`, `TURN_HOST`.
- **Інше:** у `.env.example` `REDIS_PREFIX=promo_designer:`, а default у коді `uwebsocket:` — схоже на залишок з іншого проєкту.
- **Пропозиція:** синхронізувати `.env.example` з кодом; повний перелік із призначенням і default-значеннями є на сторінці `documentation/backend/configuration.md`.

### 7. Потрібен pgvector, ніде не задокументовано

> **Виправлено** у feat-007 (гілка `feat/db-dx`): розділ [«pgvector»](https://blazheiko.github.io/vibe-template/backend/database#pgvector) у `documentation/backend/database.md` пояснює, навіщо потрібне розширення (пошук у базі знань Support AI), що буде без нього, як його встановити й перевірити; на нього посилаються `README.md`, `packages/backend/README.md`, `getting-started`, `ai`, `deployment`, `repositories-transformers`.

- **Що:** `src/db/create-database.ts` виконує `CREATE EXTENSION IF NOT EXISTS vector`. На звичайному образі `postgres` команда `db:create` падає.
- **Пропозиція:** згадати pgvector у README (у документації вже є, образ `pgvector/pgvector:pg16`).

### 8. Різні PostgreSQL defaults у застосунку та скриптах

> **Виправлено** у feat-006: застосунок, `db:create` і `drizzle.config.ts` (перейменовано з `.js`) беруть налаштування з однієї `resolveDatabaseConfig()`.

- **Що:** `drizzle.config.js` і `src/db/create-database.ts` мають defaults (`127.0.0.1`, `5432`, `postgres`, `vibe_template`). `src/config/database.ts` defaults не має (див. також п. 5).
- **Наслідок:** міграції можуть піти в одну БД, а застосунок не стартувати або підключитися не туди.
- **Пропозиція:** один спільний модуль конфігурації БД для застосунку і скриптів.

## База даних і структура

### 10. `db:seed` — порожня заглушка

> **Виправлено** у feat-007 (гілка `feat/db-dx`) за планом [`db-seed-plan.md`](./db-seed-plan.md): `db:seed` ідемпотентно вставляє три промпти `llm_system_prompts` (тексти — ті самі runtime-fallback з `config/support.ts`), а з `--demo` — адміна і, опційно, звичайного користувача з `SEED_*`. Додано `db:seed:prod`.

- **Що:** `src/db/seed.ts` містить лише `import "dotenv/config"`. Команда виконується успішно, але нічого не робить.
- **Пропозиція:** додати мінімальні seed-дані (тестовий користувач/адмін) або прибрати скрипт.

### 11. `src/drizzle/schema/index.ts` порожній

> **Виправлено** у feat-007 (гілка `feat/db-dx`): видалено порожні `src/drizzle/schema/index.ts`, а також такі самі порожні й ніде не імпортовані `src/drizzle/schema-validator.ts`, `type-guards.ts`, `types.ts`. У `src/drizzle/` лишилися тільки міграції; схема — `src/database/schema.ts`. Аліас `#drizzle/*` залишено, хоча зараз його ніхто не імпортує.

- **Що:** реальна схема лежить у `src/database/schema.ts` (на неї вказує `drizzle.config.js`), а `src/drizzle/schema/index.ts` порожній. Це вводить в оману.
- **Пропозиція:** видалити порожній файл або реекспортувати з нього схему.

Додатково (не баг): Relational Queries v2 (`src/database/relations.ts`) підключено, але жоден repository не використовує `db.query`. Транзакцій (`db.transaction`) у коді застосунку немає.

## HTTP

### 12. Тіло запиту читається лише для `post`/`put`

> **Виправлено** у feat-008 (гілка `feat/http-body-fixes`) за планом [`http-body-methods-plan.md`](./http-body-methods-plan.md): `patch` читає й валідує тіло; `validator` на `get`/`delete`/`del` заборонено типами `defineRoute` і перевіркою в `routesHandler`; маршрут з `validator` без `Content-Type` дає 422 (порожнє тіло валідується як `{}`) або 415 (є framing тіла) замість 500. Контракт `octet`-маршрутів з `validator` лишається відкритим.

- **Що:** у `src/vendor/start/server.ts` `hasBody` істинний лише для `post` і `put`. Body `PATCH` і `DELETE` ніколи не читається.
- **Наслідок:** зараз `patch`-маршрутів немає, але новий `patch`-маршрут мовчки отримає порожній payload.
- **Пропозиція:** додати `patch` (і за потреби `del`) до методів з body або явно заборонити `patch` у `defineRoute`.

### 13. `sendResponse` при `payload === null`

> **Виправлено** у feat-008 (гілка `feat/http-body-fixes`) за планом [`http-null-payload-plan.md`](./http-null-payload-plan.md): порожній payload (`null`/`undefined`) у 200 дає 204, в іншому 2xx — той самий статус без тіла; 204/205/3xx завжди без тіла й без `Content-Type` (зокрема з `responseData.headers`); у 4xx/5xx — канонічне тіло помилки з `code` зі спільного `ErrorCode`.

- **Що:** якщо `payload` дорівнює `null`, тілом відповіді стає `String(status)`, хоча `Content-Type: application/json`.
- **Пропозиція:** віддавати `null` або порожнє тіло зі статусом 204.

### 14. Прогалини плану body limits

> **Виправлено** у feat-008 (гілка `feat/http-body-fixes`) за планом [`http-body-limits-plan.md`](./http-body-limits-plan.md): тести `detectBodyKind`/`resolveMaxBodySize`, 413 через зареєстрований handler (межа рівно в ліміт, UTF-8 між чанками, розділення лімітів) і на справжньому uWS; `bodyLimits` у playground; defaults 2 / 50 / 50 / 2 MiB зафіксовано як рішення; `parseSize` приймає лише додатне безпечне ціле. `APP_MAX_*_BODY_SIZE` у `.env.example` додано ще в feat-006 (п. 6).

Згідно з `src/docs/HTTP_BODY_LIMITS_PLAN.md` основну частину реалізовано: ліміти за типом, 413, рання відмова, `onAborted`. Не зроблено:

- unit-тести для `detectBodyKind` / `resolveMaxBodySize` та інтеграційні тести на 413;
- змінні `APP_MAX_*_BODY_SIZE` у `.env.example` (див. п. 6);
- показ лімітів у playground через `serializeRoutes`;
- default-значення відрізняються від плану: у коді 2 MB / 50 MB / 50 MB / 2 MB, у плані 1 MB / 50 MB / 100 MB / 1 MB. Потрібно вирішити, що правильно.

## Документація та стиль

### 15. Застарілі внутрішні документи

> **Виправлено** у feat-009 (гілка `feat/internal-docs-cleanup`) за планом [`internal-docs-cleanup-plan.md`](./internal-docs-cleanup-plan.md). Таблиця нижче — стан на момент аудиту; уточнення: у `SECURITY_ANALYSIS.md` закрито всі 15 findings (простежування — [`docs/security/security-analysis-status.md`](../security/security-analysis-status.md)), а кореневий README уже мав `documentation/`. Скрипт `test` для `api-playground` свідомо не додано: тестів у пакеті немає.

| Документ                                 | Стан                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/docs/SESSION_SECURITY.md`           | TTL 2h і `sameSite: Strict`, а в коді 24h і `Lax`; формат cookie застарів; немає `__Host-` і CSRF        |
| `src/vendor/start/SECURITY_ANALYSIS.md`  | 12 з 15 findings виправлено; C-2, M-5 частково; L-4 відкритий                                            |
| `src/docs/etag-improvements.md`          | описує ETag, якого вже немає (зараз SHA1 content hash)                                                   |
| `src/docs/VALIDATOR_ABSTRACTION_PLAN.md` | рефакторинг здебільшого виконано; варто перетворити на ADR                                               |
| `src/vendor/directory-structure.md`      | перелічує неіснуючі файли, пропускає теки                                                                |
| `src/scripts/README.md`                  | описує скрипти, яких немає в `package.json` (`copy:static`, `export-types`), nodemon замість `tsx watch` |
| `README.md` (корінь)                     | дерево репозиторію без пакета `documentation`                                                            |
| `packages/backend/README.md`             | drift-список не згадує `SERVE_STATIC` (п. 4) і pgvector (п. 7)                                           |

Також: `api-playground` не має скрипта `test`.

### 16. Стиль коду бекенду

> **Виправлено** у feat-010 (гілка `feat/format-baseline`): один кореневий `.prettierrc.json` за `AGENTS.md` (4 пробіли, одинарні лапки, без `;`, ширина 100) замість конфігів `documentation`, `frontend`, `api-playground` (у playground був `tabWidth` 2); `.prettierignore`; окремий коміт форматування (422 файли, AST `.ts` ідентичний) записано в `.git-blame-ignore-revs`. Поза межами залишилися файли, яких не охоплює glob `format:check` — п. 71.

Багато файлів бекенду використовують подвійні лапки і крапку з комою, тоді як `AGENTS.md` описує одинарні лапки без крапки з комою. На `main` `pnpm format:check` падає на 193 файлах.

## WebSocket (знайдено під час T6.4, feat-011)

### 17. Фронтенд вшиває префікс `api/` у WS-події

> **Виправлено** у feat-024 (гілка `feat/ws-cleanup`): події будує `buildWsEvent` (`utils/ws-event.ts`) з `VITE_API_PATH_PREFIX` (за замовчуванням `api`, тип у `env.d.ts`, змінна в `.env.example`). Перевірено бекендом з `API_PATH_PREFIX=v1`: `v1/admin/subscribe_online_users` → `200`, `api/…` → `not_found`. Заодно follow-up feat-009: перевірка «Request already in progress» шукала ключ `${timestamp}_${event}`, а запит зберігався під `event`, тож два одночасні запити однієї події перезаписували один одного — тепер `hasPendingRequest` перевіряє той самий ключ. HTTP-виклики з вшитим `/api/` — п. 73.

- **Що:** `packages/frontend/src/composables/useWebSocketConnection.ts` (і `utils/websocket-base.ts`) формує подію як `` `api/${route}` ``, а ключі WS-маршрутів на сервері залежать від `API_PATH_PREFIX`.
- **Наслідок:** з будь-яким префіксом, крім `api`, усі WS-виклики отримують `not_found`.
- **Пропозиція:** брати префікс з конфігурації фронтенду (env) або з відповіді сервера.

### 18. WS upgrade без валідної сесії не відхиляється

> **Виправлено** у feat-020 (гілка `feat/response-safety`): `handleUpgrade` відповідає `401 Session expired` до `res.upgrade`, якщо `onUpgrade` повернув `missing`. Браузер бачить такий handshake як close `1006` без `open`, тож фронтенд (`resolveWebSocketCloseAction` у `utils/websocket-close.ts`) обробляє його як `4001` — оновлює WS-токен через HTTP; перший раз одразу, далі поспіль — раз на 5 с (без цього недоступний WS при робочому HTTP давав 28 оновлень за 3 с, e2e це перевіряє).

- **Що:** у `src/vendor/utils/network/ws-handlers.ts` токен неправильного формату отримує `401`. Але для токена правильного формату без живої сесії (`onUpgrade` повертає `null`) upgrade все одно виконується, і з'єднання закривається в `onOpen` кодом `4001`.
- **Наслідок:** зайве відкриття з'єднань. Разом із п. 2 (немає ліміту на upgrade) це спрощує флуд.
- **Пропозиція:** відповідати `401` до `res.upgrade`, якщо `dataAccess === null`.

### 19. Мертвий код у WebSocket-шарі

> **Виправлено** у feat-024 (гілка `feat/ws-cleanup`): видалено `src/app/state/user-storage.ts`, недосяжну гілку «Event not found» (диспетчер тепер типізовано як такий, що завжди відповідає) і клас `websocket-base.ts` (637 рядків); типи та `buildApiError` перенесено в `utils/websocket-types.ts`.

- `src/app/state/user-storage.ts` ніде не імпортується; стан з'єднань живе в `src/app/websocket/ws-connection-registry.ts`.
- Гілка «Event not found» в `onMessage` (`ws-handlers.ts`) недосяжна: диспетчер сам повертає `not_found` «Route not found».
- `packages/frontend/src/utils/websocket-base.ts` має власну логіку reconnect/ping, але `useWebSocketConnection` використовує з нього лише типи.
- **Пропозиція:** видалити або явно позначити як legacy.

## Шари, БД і валідація (знайдено під час T6.1–T6.3, feat-011)

### 20. Сервіси push-нотифікацій звертаються до БД напряму

> **Виправлено** у feat-022 (гілка `feat/push-data-access`) за планом [`push-data-access-plan.md`](./push-data-access-plan.md): новий `push-notification-log-repository.ts` (`insertMany`, `countsBySubscription`, `latestBySubscriptionIds`) у barrel; `push-notification-sender-service.ts` і `push-subscription-statistics-service.ts` не імпортують `#database/*`.

- **Що:** `src/app/services/notifications/push-notification-sender-service.ts` імпортує `db` і робить `db.insert(pushNotificationLogs)`; `src/app/services/statistics/push-subscription-statistics-service.ts` робить `db.select` по `pushNotificationLogs`. Обидва оминають репозиторій.
- **Пропозиція:** винести запити в `push-subscription-repository` (або окремий `push-notification-log-repository`).

### 21. N+1 у `findByUserIdWithLogs` і статистика в JS

> **Виправлено** у feat-022 (гілка `feat/push-data-access`) за планом [`push-data-access-plan.md`](./push-data-access-plan.md): `findByUserIdWithLogs` — 2 запити (підписки + логи через `row_number() over (partition by subscription_id …) <= 5`), 1 запит для користувача без підписок; статистика — один запит з `count(case …)`, межа 7 днів передається з годинника застосунку. pg-тест порівнює результат з дослівною копією старої реалізації.

- **Що:** `src/app/repositories/notifications/push-subscription-repository.ts` → `findByUserIdWithLogs` робить окремий запит логів на кожну підписку (`subscriptionsData.map(async …)`). Сервіс статистики завантажує всі логи і рахує агрегати в JavaScript.
- **Пропозиція:** один запит з `inArray`/join; агрегати через `count()`/`group by` у SQL.

### 22. Контролери та middleware оминають сервіси

> **Виправлено** у feat-025 (гілка `feat/layering-cleanup`): `admin-user-controller` → `adminUserService.listUsers`; `ws-coordinator` і `admin_guard` → `userRoleService.findRole`, тож задокументований виняток для guard'а не знадобився; контролери беруть `PromptType`/`PromptUpdate`/`TextFilter` із сервісів. Правила імпорту закріплює `src/app/layering.spec.ts`.

- **Що:** `src/app/controllers/http/admin/admin-user-controller.ts`, `src/app/middlewares/admin-guard.ts`, `src/app/websocket/ws-coordinator.ts` викликають `userRepository` напряму. `prompt-controller.ts` і `ai/usage/llm-usage-controller.ts` імпортують типи з модулів репозиторіїв.
- **Наслідок:** ланцюжок Controller → Service → Repository із `documentation/backend/architecture.md` не суворий.
- **Пропозиція:** перенести виклики в сервіси або явно задокументувати дозволені винятки (наприклад, guard).

### 23. `prompt-controller` сам викликає OpenAI і кидає `Error`

> **Виправлено** у feat-027 (гілка `feat/ai-reliability`) за планом [`ai-reliability-plan.md`](./ai-reliability-plan.md): `promptTestService.run` через `textAdapter`, без власного `fetch` і fallback на сирий OpenAI; нові `AppError` `UpstreamError` → `502 upstream_error` і `UpstreamTimeout` → `504 upstream_timeout` (коди в `shared` `ErrorCode`), не налаштований провайдер → `503`. Текст провайдера лише в лозі.

- **Що:** `src/app/controllers/http/ai/prompt-controller.ts` робить `fetch` до OpenAI і кидає `throw new Error(...)` замість `AppError`/`Result` через сервіс. Помилки провайдера йдуть клієнту як `500`.
- **Пропозиція:** винести в AI-сервіс (є `textAdapter`), повертати доменні помилки.

### 24. Repositories barrel неповний

> **Виправлено** у feat-025 (гілка `feat/layering-cleanup`): barrel експортує `promptRepository`, `supportRepository`, `supportKnowledgeRepository` і їхні типи, усі імпорти поза `app/repositories` — через нього; попередження з `user-online-repository` перенесено в `userOnlineService`.

- **Що:** `src/app/repositories/index.ts` не експортує `promptRepository`, `supportRepository`, `supportKnowledgeRepository`, тому частина коду імпортує через barrel, а частина напряму. `user-online-repository.ts` імпортує `logger` (логування в шарі даних).
- **Пропозиція:** доповнити barrel, прибрати логування з репозиторію.

### 25. `clearEmbedding` без транзакції

> **Виправлено** у feat-025 (гілка `feat/layering-cleanup`): замість транзакції — один `UPDATE` (`embedding = NULL` разом з `updatedAt`), атомарний сам по собі; `setEmbedding` і `searchByEmbedding` посилаються на колонки через об'єкти схеми. pg-тест: один запит, вектор скинуто.

- **Що:** `src/app/repositories/support/support-knowledge-repository.ts` → `clearEmbedding` робить два запити без `db.transaction`; SQL для embedding містить назви таблиці й колонок рядками.
- **Пропозиція:** транзакція і посилання на колонки через `sql` з об'єктами схеми.

### 26. ArkType-адаптер віддає лише `summary`

> **Виправлено** у feat-026 (гілка `feat/validation-cleanup`): адаптер повертає `issues: [{ path, message }]` (по запису на кожну помилку ArkType), а `messages` лишається `string[]`, але тепер по рядку на поле — контракт, який читає фронтенд (`details.messages`), не зламано. `issues` іде в `details` HTTP 422 і WS-помилок; тип `ValidationIssue` у `shared`. Відступ від roadmap: там пропонувалося замінити `messages[]` на об'єкти.

- **Що:** `src/app/validate/adapters/arktype-adapter.ts` повертає один `summary` як повідомлення; масив `messages[]` у помилці 422 не містить помилок по окремих полях.
- **Пропозиція:** мапити `ArkErrors` у список `{ path, message }`.

### 27. Мертвий і застарілий код

> **Виправлено** у feat-026 (гілка `feat/validation-cleanup`): видалено `validate/schemas/schemas.ts` і закоментовані імпорти, `MainController.testSentryError` (у `observability.md` — інший спосіб перевірити Sentry); docstring `ValidationError` нейтральний до рушія; `nativeValidator` → `bodySchema` у `serialize-routes.ts`; README з `422` уже виправлено у feat-009; §3.6, §5.6, §9 ADR 0001 — рішення «не робимо» з причинами в самому ADR.

- `src/app/validate/schemas/schemas.ts` — його імпорти закоментовані в `src/index.ts` і `vendor/start/server.ts`.
- `src/app/validate/errors/validation-error.ts` — docstring «ArkType validation», хоча клас не залежить від рушія.
- `src/vendor/utils/routing/serialize-routes.ts` — змінна `nativeValidator` насправді містить ArkType-опис.
- `src/app/controllers/http/core/main-controller.ts` — `testSentryError` не зареєстрований у маршрутах (у продакшні недоступний), мертвий handler.
- `packages/backend/README.md` (~рядок 343) пише `ValidationError → 400`, а код повертає `422` (`validation-error.ts`).
- `src/docs/VALIDATOR_ABSTRACTION_PLAN.md`: не зроблено §3.6 (`InputSchema` export), §9 (`nativeValidator(predicate)`), §5.6 (`ResponseSchema`/`BaseType` у `vendor/types`).

## Деплой (знайдено під час T6.8b, feat-011)

Перевірено реальним `docker build` (успішно, ~206 с, образ 817 MB) і `docker run` (без БД падає на `db:create:prod` з `ECONNREFUSED`, exit 1).

### 28. Немає `.dockerignore`

> **Виправлено** у feat-019 (гілка `feat/docker-hardening`) за планом [`docker-hardening-plan.md`](./docker-hardening-plan.md): `.dockerignore` (`.git`, `node_modules`, `dist`, `coverage`, звіти, кеш VitePress, усі `.env`/`.env.*` крім `.env.example`); build context 83,45 MB → 124,7 kB, збірка 337 → 172 с. Canary-маркер не знайдено в builder-етапі, шарах `docker save` і `docker history`. Заодно: раніше локальний `packages/frontend/.env` міг вшитися в бандл через Vite.

- **Що:** у корені немає `.dockerignore`, а `Dockerfile` робить `COPY . .`.
- **Наслідок:** у build context і builder-шар потрапляють локальні `.env`, `node_modules`, `dist`. Збірка повільніша, і є ризик витоку секретів у шари образу.
- **Пропозиція:** додати `.dockerignore` (`**/node_modules`, `**/dist`, `**/.env*` крім `.env.example`, `.git`, `documentation/.vitepress/{cache,dist}`).

### 29. Контейнер працює від root, без `HEALTHCHECK`

> **Виправлено** у feat-019 (гілка `feat/docker-hardening`) за планом [`docker-hardening-plan.md`](./docker-hardening-plan.md): системний користувач `app` (uid 999) з `/home/app`, `COREPACK_HOME=/opt/corepack`; `HEALTHCHECK` через `/api/ping` з перевіркою тіла `"status":"ok"` — тільки код відповіді не годиться, бо SPA fallback віддає 200 на будь-який шлях. З `API_PATH_PREFIX=v1` без `--health-cmd` контейнер стає `unhealthy`.

- **Що:** у `Dockerfile` немає `USER` і `HEALTHCHECK`.
- **Пропозиція:** `USER node`; `HEALTHCHECK` через `GET /api/ping`.

### 30. `CMD` через `sh -c`

> **Виправлено** у feat-019 (гілка `feat/docker-hardening`) за планом [`docker-hardening-plan.md`](./docker-hardening-plan.md): `CMD ["node", "dist/index.js"]`, PID 1 — Node: `docker stop` завершується через `stopGracefully` з кодом 0. Міграції — окремі one-shot `pnpm db:create:prod` / `pnpm db:migrate` того самого образу перед rollout (описано в `deployment.md` як зміна запуску).

- **Що:** `CMD ["sh", "-c", "node --version && pnpm db:create:prod && pnpm db:migrate && pnpm start"]`.
- **Наслідок:** міграції виконуються на кожному старті контейнера, і при кількох репліках виникає гонка. PID 1 тут — shell, тому SIGTERM може не дійти до Node, і graceful shutdown з `src/index.ts` не спрацює.
- **Пропозиція:** окремий одноразовий job для `db:create:prod`/`db:migrate`; `CMD ["node", "dist/index.js"]` (або `exec`/`tini`).

### 31. Образ не вмикає `SERVE_STATIC` і не задає `APP_ENV`

> **Виправлено** у feat-006 разом з п. 4.

- **Що:** `Dockerfile` копіює фронтенд у `public`, але не встановлює `SERVE_STATIC=true`, тож за замовчуванням контейнер фронтенд не роздає. Задано `NODE_ENV=production`, але не `APP_ENV`, а саме його читають `secure` у cookie і конфіг CSP.
- **Пропозиція:** задати `SERVE_STATIC=true` і `APP_ENV=production` в образі або явно описати їх як обов'язкові при запуску.

### 32. `corsS3.xml`: `AllowedOrigin *` разом з `PUT`

> **Виправлено** у feat-023 (гілка `feat/storage-hardening`) за планом [`storage-hardening-plan.md`](./storage-hardening-plan.md): лише `GET`/`HEAD` з placeholder-origin застосунку, `MaxAgeSeconds`; приклад для кількох оточень — `corsS3.prod.example.xml`.

- **Що:** CORS-конфіг бакета дозволяє будь-яке джерело для `GET`/`POST`/`PUT`.
- **Пропозиція:** обмежити `AllowedOrigin` доменами застосунку; для продакшну тримати окремий файл.

## Observability (знайдено під час T6.6, feat-011)

### 33. `handleError` логує без `requestId`, контекст без `userId`

> **Виправлено** у feat-030 (гілка `feat/observability`) за планом [`observability-plan.md`](./observability-plan.md): `requestId` генерується на першому кроці обробки запиту (раніше — у контексті після читання тіла, тож 413/415/422 його не мали взагалі); `handleError` пише через `logger.child({ requestId, userId, route, method })`; `userId` читається в момент помилки (раніше брався до `session_web` і завжди був `undefined`); `session_web` додає `userId` у логер запиту, WS-логер — з даних з'єднання.

- **Що:** `handleError` у `src/vendor/start/server.ts` пише через глобальний `logger`, а не через дочірній logger запиту. Тому warn-записи (413/415/422) не мають `requestId`. Дочірні логери в `src/vendor/utils/context/http-context.ts` і `ws-context.ts` отримують лише `requestId`, без `userId`.
- **Пропозиція:** передавати request logger у `handleError`; додати `userId` (коли відомий) у child-контекст.

### 34. Рівень логування не налаштовується

> **Виправлено** у feat-030 (гілка `feat/observability`) за планом [`observability-plan.md`](./observability-plan.md): `LOG_LEVEL` (`config/logging.ts`, default `info`), невалідне значення зупиняє старт.

- **Що:** `src/vendor/utils/logger.ts` створює pino без `level` (діє default `info`), змінної `LOG_LEVEL` немає. Увімкнути `debug` без зміни коду неможливо.
- **Пропозиція:** `level: env.LOG_LEVEL ?? 'info'` і документування в `.env.example`.

### 35. Немає readiness-перевірки

> **Виправлено** у feat-030 (гілка `feat/observability`) за планом [`observability-plan.md`](./observability-plan.md): `GET /<prefix>/ready`: `SELECT 1` + Redis `PING` з таймаутом `READINESS_CHECK_TIMEOUT_MS`, `200 ok` / `503 unavailable` без деталей; `HEALTHCHECK` образу — на `/api/ready`. Заодно виправлено падіння процесу при обриві з'єднання з PostgreSQL: `pg.Pool` `error` без обробника ставав `uncaughtException`.

- **Що:** `GET /api/ping` повертає статичний `{status:"ok"}` (liveness) і не перевіряє PostgreSQL, Redis, S3 чи SMTP. Окремого readiness-маршруту немає.
- **Наслідок:** оркестратор/балансувальник спрямує трафік на інстанс без доступу до БД чи Redis.
- **Пропозиція:** `GET /api/ready` з перевіркою DB і Redis (таймаути, без деталей у відповіді). Вимоги — шаблон `docs/requirements/operations/template-health-readiness-observability.md`.

## Тестування (знайдено під час T6.8a, feat-011)

Реальний прогін: `pnpm --filter backend test` — 51 файл, 268 тестів, ~2,2 с. Тести не потребують БД чи Redis, uWS мокається.

### 36. Немає CI для тестів застосунку і coverage

> **Виправлено** у feat-018 (гілка `feat/app-ci`) за планом [`app-ci-plan.md`](./app-ci-plan.md): `.github/workflows/ci.yml` на кожен PR і push у `main` — job `quality` (`format:check`, `typecheck`, `lint`, `test`, coverage як artifact) і `e2e` (усі 4 проєкти Playwright). `@vitest/coverage-v8` і `test:coverage` у backend і frontend, без порогу. Redis-тести лишаються в `redis-tests.yml`.

- **Що:** єдиний workflow — `.github/workflows/docs.yml`, і він тестує лише пакет `documentation`. Backend-, frontend- і shared-тести, typecheck та lint в CI не запускаються, лише локально через `./init.sh`. Coverage-інструментів чи скриптів немає в жодному пакеті.
- **Пропозиція:** workflow `ci.yml` на PR (`pnpm typecheck`, `pnpm lint`, `pnpm test`, за потреби e2e); `@vitest/coverage-v8` зі звітом.

### 37. `vitest.config.ts` без `testTimeout`

> **Виправлено** у feat-018 (гілка `feat/app-ci`) за планом [`app-ci-plan.md`](./app-ci-plan.md): `testTimeout: 15_000` у backend; `maxWorkers` з `VITEST_MAX_WORKERS` (у CI — 2).

- **Що:** `packages/backend/vitest.config.ts` не задає `testTimeout`, тож діє default 5 с. Під час feat-003 7 з 268 тестів один раз впали з таймаутом при паралельному навантаженні (typecheck + lint). При повторних прогонах — 268/268.
- **Пропозиція:** явний `testTimeout` і/або обмеження `poolOptions` для CI.

### 38. Playwright `webServer` використовує `npm`

> **Виправлено** у feat-018 (гілка `feat/app-ci`) за планом [`app-ci-plan.md`](./app-ci-plan.md): `pnpm run dev` / `pnpm run preview`; заодно `pnpm run build-sw` у скрипті `build` фронтенду.

- **Що:** `packages/frontend/playwright.config.ts` запускає `npm run dev` / `npm run preview`, хоча репозиторій — pnpm-workspace.
- **Пропозиція:** `pnpm dev` / `pnpm preview`.

## Кешування (знайдено під час T6.7, feat-011)

### 39. Річний `immutable` для всіх не-HTML файлів

> **Виправлено** у feat-031 (гілка `feat/static-caching`) за планом [`static-caching-plan.md`](./static-caching-plan.md): `immutable` лише для `/assets/*`, решта — `no-cache` з ETag (`manifest.json`, `service-worker.js`, іконки, аудіо).

- **Що:** `src/vendor/start/static-server.ts` віддає `public, max-age=31536000, immutable` для кожного не-HTML файлу, а не лише для хешованих `/assets/*`. Під нього потрапляють `manifest.json`, `favicon.svg`, `/icons/*`, `/audio/*` і `service-worker.js` (збирається з фіксованим ім'ям у `packages/frontend/vite.sw.config.ts`).
- **Наслідок:** зміни в цих файлах без зміни імені клієнти можуть не бачити до року. Скрипт SW браузер перевіряє в обхід HTTP-кешу, але маніфест, іконки й аудіо — ні.
- **Пропозиція:** `immutable` лише для `/assets/` (хешовані імена), для решти `no-cache` або короткий `max-age`.

### 40. `If-None-Match` порівнюється як точний рядок

> **Виправлено** у feat-031 (гілка `feat/static-caching`) за планом [`static-caching-plan.md`](./static-caching-plan.md): `matchesIfNoneMatch` за RFC 9110: `*`, списки, слабке порівняння `W/`.

- **Що:** у `static-server.ts` перевірка `ifNoneMatch === etag`. Списки ETag, `*` і слабкі `W/"…"` не обробляються.
- **Пропозиція:** розбирати заголовок за RFC 9110.

### 41. Статика повністю в RAM без стиснення і ліміту

> **Виправлено** у feat-031 (гілка `feat/static-caching`) за планом [`static-caching-plan.md`](./static-caching-plan.md): `STATIC_MAX_MEMORY_FILE_SIZE` (1 MiB) і `STATIC_MAX_MEMORY_TOTAL` (64 MiB), решта стрімінгом з диска з backpressure; `br`/`gzip`-варіанти текстових файлів на старті з `Vary: Accept-Encoding`. Відступ від roadmap: стиснення на старті сервера, а не `.br`/`.gz` при збірці фронтенду — без нових залежностей і для будь-якого вмісту `public`.

- **Що:** увесь `public` читається в пам'ять на старті без ліміту розміру; gzip/brotli немає.
- **Пропозиція:** попередньо стиснуті `.br`/`.gz` при збірці; ліміт або стрімінг для великих файлів; або роздача статики через CDN/проксі (`CDN_URL`).

### 42. API JSON без `Cache-Control: no-store`

> **Виправлено** у feat-020 (гілка `feat/response-safety`): `setApiCacheHeader` додає `Cache-Control: no-store` до кожної API-відповіді (`sendResponse` і `sendErrorResponse`), якщо контролер не задав власний `Cache-Control`; статика не змінилась.

- **Що:** `sendResponse` у `src/vendor/start/server.ts` не ставить `Cache-Control` на JSON-відповіді, зокрема на auth- і session-відповіді.
- **Наслідок:** проміжні кеші або браузер можуть зберігати персональні дані з відповідей.
- **Пропозиція:** `Cache-Control: no-store` за замовчуванням для API.

### 43. Кеш промптів у пам'яті процесу без TTL

> **Виправлено** у feat-029 (гілка `feat/ai-quality`) за планом [`ai-quality-plan.md`](./ai-quality-plan.md): `PROMPT_CACHE_TTL_MS` (60 с): прострочений кеш віддає поточне значення й перечитує промпти у фоні (одне перечитування одночасно, помилка лишає старі значення); `update()` на своєму інстансі видно одразу. Pub/sub між інстансами — поза фічею, затримка ≤ TTL описана в документації.

- **Що:** `src/app/services/ai/prompt-service.ts` тримає `Map` промптів у процесі без TTL та інвалідації між інстансами.
- **Наслідок:** оновлення промпту на одному інстансі не видно на інших до рестарту.
- **Пропозиція:** TTL або інвалідація через Redis pub/sub.

## Інтеграції: S3, пошта/push, AI (знайдено під час T6.5a–c, feat-011)

### 44. `deleteFromS3` без `buildKey`

> **Виправлено** у feat-023 (гілка `feat/storage-hardening`) за планом [`storage-hardening-plan.md`](./storage-hardening-plan.md): `buildKey` експортується як `buildObjectKey`, `deleteFromS3` приймає відносний ключ, як решта функцій; обидві копії `buildFullS3Key` видалено (CDN URL скриншота — через `buildObjectKey`).

- **Що:** у `src/vendor/utils/storage/s3.ts` `upload`/`getSignedUrl`/`download` застосовують `buildKey` (префікс), а `deleteFromS3` — ні. Тому `avatar-service.ts` і `knowledge-base-service.ts` мають власні копії `buildFullS3Key`. Виклик з відносним ключем мовчки нічого не видаляє.
- **Пропозиція:** `buildKey` у `deleteFromS3`, прибрати дублікати.

### 45. Аватари без `public-read`

> **Виправлено** у feat-023 (гілка `feat/storage-hardening`) за планом [`storage-hardening-plan.md`](./storage-hardening-plan.md): за рішенням Р1 аватари завантажуються з `publicRead: true`; про старі приватні об'єкти — у `storage.md`.

- **Що:** `src/app/services/user/avatar-service.ts` завантажує аватари без `publicRead`, а фронтенд читає їх напряму за CDN URL. Вони відображаються лише тоді, коли бакет або CDN зроблено публічними поза кодом.
- **Пропозиція:** явно задати політику: `publicRead` для аватарів або видача через signed URL.

### 46. MIME-тип довіряється заголовку клієнта

> **Виправлено** у feat-023 (гілка `feat/storage-hardening`) за планом [`storage-hardening-plan.md`](./storage-hardening-plan.md): `detectImageType` (magic bytes PNG/JPEG/WebP); аватари й скриншоти приймаються, лише коли тип за вмістом дозволений і збігається з заявленим, інакше `400`. `ContentType` і розширення ключа — з виявленого типу, ім'я файлу клієнта не використовується.

- **Що:** `avatar-service.ts` і `knowledge-base-service.ts` перевіряють MIME за multipart-заголовком, без перевірки сигнатури вмісту. Розширення аватара береться з імені файлу клієнта.
- **Пропозиція:** перевіряти magic bytes; розширення виводити з перевіреного типу.
- Також: оскільки всі завантаження йдуть через бекенд, `PUT`/`POST` у `corsS3.xml` не потрібні (доповнює п. 32).

### 47. Підписка push перепризначається іншому користувачу

> **Виправлено** у feat-021 (гілка `feat/push-access`): за рішенням Р2 ([`open-issues-roadmap.md`](./open-issues-roadmap.md)) endpoint іншого користувача переноситься лише при збігу `p256dhKey` і `authKey`, інакше `409 conflict` і власник не змінюється.

- **Що:** `push-subscription-service.ts` → `createSubscription` шукає endpoint серед усіх користувачів і викликає `updateByEndpoint(endpoint, userId, …)`, що переносить підписку на поточного користувача.
- **Наслідок:** ризик невеликий, бо endpoint — секретний URL від push-сервісу. Але поведінка неявна (наприклад, при зміні акаунта на тому ж пристрої це бажано, при витоку endpoint — ні).
- **Пропозиція:** явно задокументувати або обмежити перенесення (наприклад, лише з тим самим `p256dh`/`auth`).

### 48. `GET /test-push` з побічними ефектами

> **Виправлено** у feat-021 (гілка `feat/push-access`): `POST /push-subscriptions/test-push` з тілом `PushSubscriptionTestInputSchema` (`title?` ≤ 200, `body?` ≤ 1000) замість query; тепер маршрут захищений `csrf_guard`. `GET /test-push` потрапляє в `GET /:subscriptionId` і дає `404` (нечисловий id більше не дає 500 через `BigInt`).

- **Що:** у `src/app/routes/http-routes.ts` `test-push` має метод `get`, але надсилає push і пише логи. `csrf_guard` перевіряє лише небезпечні методи (`UNSAFE_METHODS`), тож маршрут від CSRF не захищено.
- **Пропозиція:** `POST`.

### 49. Push надсилається лише з `test-push`

> **Виправлено** у feat-022 (гілка `feat/push-data-access`) за планом [`push-data-access-plan.md`](./push-data-access-plan.md): `sendToUser` відправляє паралельно (`PUSH_SEND_CONCURRENCY = 5`), логи пишуться одним `insertMany`, `lastUsedAt` — одним `touchLastUsed`. Підключення до бізнес-подій винесено в п. 72.

- **Що:** `push-notification-sender-service.ts` → `sendToUser` викликається тільки з `test-push`; жодна бізнес-подія push не надсилає, `skipIfOnline`/`notificationType` не використовуються. Підписки обробляються послідовно, з двома `await`-записами в БД на кожну.
- **Пропозиція:** підключити до реальних подій; паралельна відправка з обмеженням і пакетний запис логів.

### 50. Невідомий `AI_TEXT_DRIVER` мовчки дає Mistral

> **Виправлено** у feat-027 (гілка `feat/ai-reliability`) за планом [`ai-reliability-plan.md`](./ai-reliability-plan.md): `config/ai.ts` приймає лише `openai`, `xai`, `mistral`, інакше `configError` → `validateRuntimeConfig()` зупиняє старт.

- **Що:** `src/app/services/ai/ai-provider.ts` повертає `mistralaiTextAdapter` для будь-якого значення, крім `openai` і `xai`, тож друкарська помилка не помітна.
- **Пропозиція:** валідація в `validate-runtime-config.ts` з помилкою на старті.

### 51. Виклики AI-провайдерів без timeout

> **Виправлено** у feat-027 (гілка `feat/ai-reliability`) за планом [`ai-reliability-plan.md`](./ai-reliability-plan.md): `AI_REQUEST_TIMEOUT_MS` (60 000) і `aiRequestSignal` в усіх адаптерах; `HttpContext.signal` (з `res.onAborted`) і `WsContext.signal` (сигнал з'єднання, abort в `onClose`) передаються в тест промпту й Support AI. Наживо: завислий провайдер → 504 за 1,57 с при ліміті 1,5 с; клієнт пішов через 1 с → з'єднання з провайдером закрито на 997 мс.

- **Що:** адаптери в `src/app/services/ai/adapters/*` і `prompt-controller.ts` не передають timeout чи `AbortSignal`.
- **Пропозиція:** таймаут і скасування при закритті WS/HTTP.

### 52. Support AI: `langNative = 'ru'` зашито в коді

> **Виправлено** у feat-029 (гілка `feat/ai-quality`) за планом [`ai-quality-plan.md`](./ai-quality-plan.md): фронтенд передає i18n-локаль у полі `language` обох WS-подій; `resolveSupportLanguage` зводить її до `APP_LOCALE_CODES`, інакше `SUPPORT_DEFAULT_LANGUAGE` (`en`, перевіряється на старті). Мови в профілі користувача немає — окрема фіча.

- **Що:** `src/app/services/support/support-service.ts` у `chat()` і `openChat()` задає `const langNative = 'ru'`, ігноруючи мову користувача.
- **Пропозиція:** брати мову з профілю/запиту.

### 53. Неповний облік використання AI

> **Виправлено** у feat-028 (гілка `feat/ai-usage-accounting`) за планом [`ai-usage-accounting-plan.md`](./ai-usage-accounting-plan.md): записуються переклад (`SUPPORT_QUERY_TRANSLATION`), тест промпту (`PROMPT_TEST`) і embeddings (нова feature `SUPPORT_EMBEDDING`); міграція робить токени й `user_id` nullable — `NULL` = провайдер не повідомив usage (адаптери більше не пропускають такі виклики, а пишуть `NULL` і `warn`), `user_id` `NULL` — індексація без користувача; статистика рахує `callsWithoutUsage` окремо.

- **Що:** переклад (`support-query-translation-service.ts`) і тест промпту (`prompt-controller.ts`) не передають `onComplete`, тому `SUPPORT_QUERY_TRANSLATION` і `PROMPT_TEST` не записуються. Embeddings не обліковуються. `mistralai-text-adapter.ts` мовчки пропускає запис, якщо провайдер не повернув usage.

### 54. Embeddings

> **Виправлено** у feat-029 (гілка `feat/ai-quality`) за планом [`ai-quality-plan.md`](./ai-quality-plan.md): `OPENAI_EMBEDDING_DIMENSIONS` ≠ `EMBEDDING_COLUMN_DIMENSIONS` (1536) зупиняє старт; `reindexAll` пачками `SUPPORT_EMBEDDING_BATCH_SIZE` (50); `searchByEmbedding` відкидає статті далі `SUPPORT_SEARCH_MAX_DISTANCE` (0.8, не відкалібровано — у `ai.md` описано, як підібрати).

- **Що:** `src/database/schema.ts` має `vector(1536)`, хоча `OPENAI_EMBEDDING_DIMENSIONS` налаштовується: зміна змінної без міграції зламає запис. `support-embedding-service.ts` → `reindexAll` шле всі статті одним `embedBatch`. `searchByEmbedding` (`support-knowledge-repository.ts`) не має порогу відстані, тож у контекст завжди йде до 5 статей.

### 55. `llm_text_usage.final_prompt` зберігає повні тексти

> **Виправлено** пізніше (feat-065): [`purge-llm-prompts.ts`](../../packages/backend/src/scripts/purge-llm-prompts.ts) видаляє текст промптів, зберігаючи SHA-256 і довжину; retention — opt-in. Початкове рішення Р3 у [`open-issues-roadmap.md`](./open-issues-roadmap.md) («відкладено») застаріло.

- **Що:** у `llm_text_usage.final_prompt` безстроково зберігаються повні повідомлення користувачів та історія, і адміністратор бачить їх через `/admin/usage/text`.
- **Наслідок:** персональні дані без політики зберігання.
- **Пропозиція:** retention-політика, маскування, або зберігати лише метадані.

## Пакети shared, frontend, playground (знайдено під час T6.9a–c, feat-011)

### 56. Тест shared не містить жодного тесту

> **Виправлено** у feat-032 (гілка `feat/shared-cleanup`): 13 тестів у `languages.test.js`, `phone.test.js`, `contracts.test.js` (і наявний `ws-channels.test.js`): мови, телефони, коди помилок, `EntityIdSchema`, вибрані схеми вводу.

- **Що:** `packages/shared/test/languages.test.js` має лише два імпорти (`node:test`, `node:assert/strict`) без жодного тест-кейсу. Тому `pnpm test` для shared показує `pass 1`: це «пройдений» файл, а не реальний тест.
- **Пропозиція:** тести для schemas/utils (наприклад, `utils/phone`, enums мов) або прибрати скрипт.

### 57. `guards` у shared порожні

> **Виправлено** у feat-032 (гілка `feat/shared-cleanup`): guards (з feat-005 — `isWsChannel`) реекспортуються з кореня `shared`, підшлях `shared/guards` лишився.

- **Що:** `packages/shared/src/guards/index.ts` містить лише `export {}`; реекспорт закоментовано в `src/index.ts`, але `./guards` є в `exports` `package.json`.
- **Пропозиція:** видалити з `exports` або наповнити.

### 58. `EntityIdSchema` не брендований

> **Виправлено** у feat-032 (гілка `feat/shared-cleanup`): `.brand('EntityId')`; тест типів у backend (`@ts-expect-error` на присвоєнні рядка) — без бренду typecheck падає (перевірено).

- **Що:** `packages/shared/src/brands/ids.ts` описує `EntityIdSchema` як regex-тип без `.brand(...)`, тож тека `brands` не дає брендованих типів.

### 59. Фронтенд: fallback `VITE_BASE_URL`

> **Виправлено** у feat-033 (гілка `feat/frontend-playground`): без змінної (і з порожнім значенням у `.env.example`) запити йдуть same-origin — через Vite proxy у dev; домену-прикладу в бандлі немає.

- **Що:** `packages/frontend/src/utils/base-api.ts` без `VITE_BASE_URL` бере `https://vibe-template.example`, тож у dev запити оминають Vite proxy, доки змінну не задано.
- **Пропозиція:** fallback на відносний шлях (same-origin через proxy).

### 60. Фронтенд: `console.log(data)` з `wsToken`

> **Виправлено** у feat-014: `console.log(data)` прибрано з `App.vue`; у production-збірці `console.log/info/debug/trace` вирізаються через `esbuild.pure` (`packages/frontend/vite.console.ts`).

- **Що:** `packages/frontend/src/App.vue` → `initializeApp` має `console.log(data)`, що друкує всю відповідь init, зокрема користувача і `wsToken`, у консоль браузера (і, можливо, в Sentry breadcrumbs).
- **Пропозиція:** прибрати; доповнює п. 3 (токени в логах).

### 61. Фронтенд: нетипізовані змінні та застарілі коментарі

> **Виправлено** у feat-033 (гілка `feat/frontend-playground`): `env.d.ts` типізує всі `VITE_*`, які читає код; закоментований код push-дозволів і хибний коментар «щохвилини» з `main.ts` прибрано. Захисту від звертання до неоголошеної змінної немає: `vite/client` має індексну сигнатуру в `ImportMetaEnv`.

- **Що:** `packages/frontend/src/env.d.ts` типізує лише `VITE_BASE_URL`, а не `VITE_AUTH_PHONE_ENABLED` і `VITE_SENTRY_*`. У `main.ts` закоментований код push-дозволів і коментар про перевірку оновлень «щохвилини», хоча вона одноразова.

### 62–64. API Playground

> **Виправлено** у feat-033 (гілка `feat/frontend-playground`): **62:** `utils/api-path.ts` — шлях маршрутів і health-check під `VITE_API_PATH_PREFIX` з урахуванням `baseUrl`, proxy з тієї ж змінної; **63:** `https` → `wss`; **64:** `sendMessage` без з'єднання нічого не обіцяє — помилка в консоль і `false` (рішення Р4). Також: Test Connection б'є в `/<prefix>/ping` замість неіснуючого `/health`; у playground з'явився скрипт `test` (Vitest, 11 тестів).

- **62:** `packages/api-playground/src/stores/api-doc.ts` викликає `fetch('/api/doc/routes')`, ігноруючи `baseUrl` і `API_PATH_PREFIX`; Vite proxy теж обмежений `/api`.
- **63:** `src/components/api/TestFormWs.vue` перетворює `https://` на `ws://` замість `wss://`.
- **64:** `src/composables/useWebSocketConnection.ts` → `sendMessage` без з'єднання логує «message queued», але черги немає, і повідомлення губиться.
- Також: у playground немає скрипта `test`.

## Процес, toolchain, ролі (знайдено під час T6.10a–d, feat-011)

### 65. `POST /main/save-user`: анонімне створення користувача з паролем у відкритому тексті — КРИТИЧНО

> ✅ **Виправлено у feat-012 (2026-10-20):** маршрут, `MainController.saveUser`, `mainService.saveUser`, схеми `SaveUserInput`/`SaveUserResponse`/`WSSaveUserPayload` і `api.saveUser` на фронтенді видалено. Залишається перевірити БД на записи, створені через цей маршрут: усі хеші від `hashPassword` (metautil) мають префікс `$scrypt$`, тож нехешовані паролі знаходить запит
>
> ```sql
> SELECT id, email, created_at FROM users
> WHERE password IS NOT NULL AND password NOT LIKE '$scrypt$%';
> ```
>
> Таким записам варто скинути пароль (наприклад, `password = NULL` + примусовий reset) або видалити їх, якщо це тестові акаунти.

- **Що:** у `src/app/routes/http-routes.ts` маршрут `POST /<prefix>/main/save-user` входить у групу `main` лише з `session_web` і `csrf_guard`, без `auth_guard`. CSRF за замовчуванням лише логується (`CSRF_ENFORCE=false`). `mainService.saveUser` (`src/app/services/core/main-service.ts`) викликає `userRepository.create({ name, email, password: payload.password })`, а `user-repository.ts` вставляє дані як є. Хешування немає, хоча звичайна реєстрація використовує `hashPassword` з `metautil` (`auth-service.ts`).
- **Наслідок:** будь-хто анонімно створює акаунти в обхід реєстрації (верифікація email, throttling), а пароль зберігається в БД **відкритим текстом**.
- **Пропозиція:** видалити маршрут (схоже на залишок демо) або закрити `admin_guard` і хешувати пароль. Перевірити БД на вже створені записи з нехешованими паролями.

### 66. `users.isAdmin` — мертве поле

> **Виправлено** у feat-034 (гілка `feat/drop-is-admin`): поле прибрано з коду й схеми, колонку — міграцією `20261024171546_drop_users_is_admin` (рішення Р5); права — лише за `role`. На dev-БД розбіжностей `is_admin`/`role` не було (0 з 94).

- **Що:** `src/database/schema.ts` має і `isAdmin` (`is_admin`), і `role` (`user`/`admin`). `admin-guard.ts`, фронтенд-стор `isAdmin()` і WS-сервіс адмін-каналу перевіряють лише `role`.
- **Пропозиція:** видалити `is_admin` міграцією або синхронізувати з `role`.

### 67. Push-група без `auth_guard`

> **Виправлено** у feat-021 (гілка `feat/push-access`): `auth_guard` на кожному маршруті `push-subscriptions`, крім `vapid-public-key`; WS-група `admin/*` з новим `ws_admin_guard` (роль з `userData` з'єднання). Перевірки в контролері й сервісі лишилися як додатковий захист; матрицю перевіряє `src/app/routes/route-access.spec.ts`.

- **Що:** група `push-subscriptions` у `http-routes.ts` не має `auth_guard`; автентифікація перевіряється в контролері через `getUserId()`; `vapid-public-key` доступний анонімно (це нормально). WS-маршрут `admin/subscribe_online_users` без guard — роль перевіряється в `admin-ws-channel-service.ts`.
- **Пропозиція:** декларативні guard'и на маршрутах, щоб матриця доступу читалася з `http-routes.ts`.

### 68. ESLint `strictTypeChecked` фактично вимкнено

> **Виправлено** у feat-035 (гілка `feat/eslint-strict`, PR #91, #92 і PR 3): бекенд — повний профіль кореня (у тестах вимкнено шість правил з поясненнями); frontend і api-playground — `strictTypeChecked` + `stylisticTypeChecked` для `.ts` і `.vue` у власних конфігах. Виявилося, що блоки для frontend і playground у кореневому конфігу ніколи не діяли: ESLint 10 бере найближчий `eslint.config.*`.

- **Що:** `eslint.config.ts` для backend, frontend і api-playground вимикає більшість правил `strictTypeChecked`, тож суворий профіль діє лише на shared і кореневі файли. ~~У корені немає `.prettierrc` — backend і shared форматуються дефолтами Prettier (доповнює п. 16).~~ Prettier-частину виправлено у feat-010.

### 69. `AGENTS.md`: застарілий опис

> **Виправлено** у feat-009: речення про відсутню `.git`-історію прибрано, опис Drizzle-тек уточнено.

- **Що:** розділ «Commit & Pull Request Guidelines» стверджує, що «this checkout does not include .git history», хоча історія є.

### 70. Основний Redis-клієнт без таймауту

Знайдено під час ручної перевірки feat-013.

- **Що:** `src/database/redis.ts` створює ioredis без `commandTimeout` і з offline queue за замовчуванням (`maxRetriesPerRequest: 20`). Коли Redis недоступний, кожен запит, що читає сесію (HTTP-middleware сесії, `verifyUpgradeToken`), чекає ~45 с і завершується `500 MaxRetriesPerRequestError`.
- **Наслідок:** під час збою Redis запити накопичуються замість швидкої відмови; у `APP_ENV=local` текст помилки ioredis потрапляє у відповідь.
- **Пропозиція:** `commandTimeout` і менший `maxRetriesPerRequest` для основного клієнта (з урахуванням того, що сесії мають переживати короткі збої), швидка `503` при недоступному Redis; readiness-перевірка (п. 35).

> **Виправлено** у feat-016 (гілка `feat/redis-main-client-timeout`) за планом [`redis-main-client-timeout-plan.md`](./redis-main-client-timeout-plan.md): основний клієнт без offline queue і повторів, з таймаутом `REDIS_COMMAND_TIMEOUT_MS` (500 мс); недоступний Redis дає `503 service_unavailable` з `Retry-After: 1` без тексту ioredis; одна подія Sentry на інцидент (`redis-health.ts`); WS-з'єднання не закриваються, heartbeat не залежить від Redis, upgrade — `503`; `logoutAll` обмежений `REDIS_LOGOUT_ALL_DEADLINE_MS`. Readiness-перевірка (п. 35) — окремо.

## Що варто зробити далі

> Актуальний порядок і розбиття на фічі (feat-010, feat-018…feat-036) — у [`open-issues-roadmap.md`](./open-issues-roadmap.md). Список нижче — первинна пропозиція аудиту.

Пропоную оформити окремі записи в `feature_list.json` (через PR у `main`):

0. ~~Негайно: п. 65 (`save-user`)~~ — виправлено у feat-012.
1. **security-hardening** — п. 1, 2, 3, 9, 18, 32, 42, 46, 47, 48, 60, 67.
2. **env-example-sync** — п. 4, 5, 6, 8 (+ README).
3. **db-dx** — п. 7, 10, 11.
4. **http-body-fixes** — п. 12, 13, 14.
5. **internal-docs-cleanup** — п. 15 (видалити або оновити застарілі документи).
6. **format-baseline** — п. 16.
7. Окремої фічі поки немає: п. 17 і 19 — кандидати в новий запис (WebSocket cleanup).
8. Окремої фічі поки немає: п. 20–25 — кандидати в новий запис (layering & data access cleanup);
   п. 26 — до feat-008 або окремо; п. 27 — до feat-009.
9. Окремої фічі поки немає: п. 28–31 — кандидати в новий запис (Docker hardening).
10. Окремої фічі поки немає: п. 33–35 — кандидати в новий запис (observability: логування та readiness).
11. Окремої фічі поки немає: п. 36–38 — кандидати в новий запис (CI для застосунку + coverage).
12. Окремої фічі поки немає: п. 39–41, 43 — кандидати в новий запис (static/caching).
13. Окремої фічі поки немає: п. 44, 45, 49 — storage/push cleanup; п. 50–55 — AI reliability & privacy.
14. Окремої фічі поки немає: п. 56–58 — shared cleanup + тести; п. 59, 61 — frontend; п. 62–64 — playground.
15. п. 66 — db-dx (feat-007); п. 68 — format-baseline (feat-010); п. 69 — internal-docs-cleanup (feat-009).

## Знайдено під час feat-010

### 71. `format:check` не перевіряє `.vue`, `.js`, `.mjs`, `.css`

> **Виправлено** у feat-038 (гілка `feat/format-push-prefix`): glob кореневих `format` / `format:check` — `**/*.{ts,tsx,js,mjs,vue,json,md,css}`; 60 файлів відформатовано окремим комітом `dd9db8b`, доданим у `.git-blame-ignore-revs`.

- **Що:** кореневі скрипти `format` / `format:check` мають glob `**/*.{ts,tsx,json,md}`. Vue-компоненти frontend і api-playground, `.js`/`.mjs` (зокрема `documentation/scripts`, `packages/shared/test`) і CSS у CI не перевіряються; пакетні скрипти `format` у frontend/playground форматують лише `src/` і тепер беруть кореневий конфіг (4 пробіли), тож для playground перший запуск переформатує `.vue` з 2 на 4 пробіли.
- **Пропозиція:** розширити glob до `{ts,tsx,js,mjs,vue,json,md,css}` окремим комітом форматування (і додати його в `.git-blame-ignore-revs`).

## Знайдено під час feat-022

### 72. Push не надсилається жодною бізнес-подією

> **Виправлено** у feat-038 (гілка `feat/format-push-prefix`): `user-notification-service.ts` надсилає push як `system` на новий вхід, зміну й скидання пароля, вихід з усіх пристроїв, і як `mention` зі `skipIfOnline` на відповідь підтримки. Виклики без очікування, збій push не впливає на відповідь.

Винесено з п. 49 (feat-022).

- **Що:** `pushNotificationSenderService.sendToUser` викликає лише `POST /push-subscriptions/test-push`. Параметри `skipIfOnline` і `notificationType` реалізовані й покриті тестами, але жоден виклик їх не передає; типи `mention` / `system` у підписці ні на що не впливають.
- **Пропозиція:** визначити події, що мають надсилати push (наприклад, відповідь підтримки, коли користувач офлайн), і викликати `sendToUser` з `skipIfOnline: true` та відповідним `notificationType`.

## Знайдено під час feat-024

### 73. HTTP-виклики фронтенду вшивають `/api/`

> **Виправлено** у feat-038 (гілка `feat/format-push-prefix`): HTTP-шляхи (`utils/api-path.ts`, `apiPath()`), OAuth-посилання, URL скриншотів і сховища, service worker і ключ Vite proxy беруть префікс з `VITE_API_PATH_PREFIX`; `WS_API_PREFIX` замінено на спільний `API_PREFIX`. Заодно прибрано залишковий fallback `https://vibe-template.example` у `stores/state.ts` (п. 59).

- **Що:** `packages/frontend/src/utils/api.ts` має 46 шляхів виду `'/api/...'`, а Vite proxy (`vite.config.ts`) теж налаштований лише на `/api`. Після feat-024 WS-події беруть префікс з `VITE_API_PATH_PREFIX`, а HTTP — ні, тож бекенд з іншим `API_PATH_PREFIX` працює з фронтендом лише через переписування шляхів на проксі.
- **Пропозиція:** будувати HTTP-шляхи з того самого `WS_API_PREFIX` (перейменувати на `API_PREFIX`) і брати proxy-ключ з тієї ж змінної; суміжне з п. 62 (playground).

## Знайдено під час роботи над документацією для початківців

### 74. Спільні контракти ловлять розбіжності лише частково

> **Частково виправлено:** `InitResponse` тепер виводиться зі схеми (`WithCanonicalError<typeof InitResponseSchema.infer>`, [`main-controller.ts`](../../packages/shared/src/responses/main-controller.ts)). Решта пункту (інші ручні типи, типи push-підписок, runtime-перевірка відповідей) окремо не перевірялася — див. [`docs-issues-fix-audit.md`](./docs-issues-fix-audit.md).

- **Що:** перевірено перейменуванням полів у `packages/shared/src/responses` і `pnpm typecheck`. `AdminUserListItem.name` → помилки і в backend, і у frontend. `InitResponseSchema.wsUrl` → помилок немає: тип `InitResponse` написано вручну окремо від схеми і він `extends Record<string, unknown>`. Перейменування поля в інтерфейсі `InitResponse` дає одну помилку у frontend (`App.vue`), backend не помічає, бо зайві ключі дозволені. `PushSubscriptionSchema.isActive` → помилок немає: frontend має власні типи підписок, backend не прив'язує повернення до цього типу. `ResponseSchema` маршрутів використовується лише для серіалізації опису API (`serialize-routes.ts`), відповідь під час виконання не перевіряється.
- **Пропозиція:** виводити типи відповідей лише зі схем (`.infer`) і прибрати ручні інтерфейси з `Record<string, unknown>`; у frontend `utils/api.ts` використовувати типи зі `shared/responses` замість локальних; розглянути перевірку відповіді за `ResponseSchema` у dev/test-режимі.

### 75. OAuth без налаштувань веде на провайдера з порожнім `client_id`

> **Виправлено:** сервіс перевіряє `clientId`/`clientSecret`/`redirectUri` перед редиректом, `GET /auth/oauth/providers` віддає налаштовані провайдери, `SocialAuthButtons.vue` показує кнопки лише для них.

- **Що:** з `.env.example` (порожні `GOOGLE_CLIENT_ID` тощо) `GET /api/auth/oauth/google/redirect` відповідає `302` на `accounts.google.com/...&client_id=&redirect_uri=`. Користувач бачить помилку Google замість зрозумілої відповіді застосунку, а кнопки соцвходу показуються, хоча провайдер не налаштований.
- **Пропозиція:** повертати `404`/`503 provider_not_configured` для провайдера без `client_id`/`secret` і віддавати фронтенду список налаштованих провайдерів, щоб ховати зайві кнопки.

### 76. Дати користувача зсунуті на часовий пояс сервера

> **Частково виправлено** (feat-085, [`docs-issues-fix-plan.md`](./docs-issues-fix-plan.md)): зсув часу виправлено — усі пули застосунку й `db:seed` відкривають з'єднання з `TimeZone=UTC` ([`pool-options.ts`](../../packages/backend/src/database/pool-options.ts)), тож `now()` і JS `Date` дають той самий пояс. Міграцію на `timestamptz` не робили. **Відкрито:** різний формат дат у відповідях login та init (спільний DTO через `userTransformer`) — не входив у feat-085.

- **Що:** demo-акаунт, створений seed-ом одним викликом, у `GET /api/main/init` має `emailVerifiedAt: 2026-10-25T15:05:42Z` і `createdAt: 2026-10-25T17:05:42Z` (сервер у UTC+2). Одне з полів інтерпретується як локальний час замість UTC. Крім того, відповідь `POST /api/auth/login` віддає `created_at`/`updated_at` (snake_case, з офсетом), а `init` — `createdAt`/`updatedAt` (camelCase, `Z`).
- **Причина (перевірено):** колонки оголошено як `timestamp` без часового поясу. `defaultNow()` пише `now()` у поясі сесії PostgreSQL (локальна інсталяція — `Europe/Kiev`), а значення з JS `Date` (`email_verified_at`) пишуться в UTC; node-pg читає обидва як UTC. Після `ALTER DATABASE ... SET timezone TO 'UTC'` зсув зникає. В образі `pgvector/pgvector` пояс UTC, тому в Docker проблеми не видно. Туторіал «Як додати фічу» повторює той самий патерн для `notes`.
- **Пропозиція:** перейти на `timestamp(..., { withTimezone: true })` (міграція `timestamptz`) або фіксувати `timezone=UTC` у пулі з'єднань (`options: '-c timezone=UTC'`); привести відповідь login до того ж DTO, що й init (через `userTransformer`).

### 77. Поле `token` у схемі входу обов'язкове, але не використовується

> **Виправлено** (feat-085): `token` опційний в обох формах `LoginInputSchema`; поле з рядком і далі приймається.

- **Що:** `LoginInputSchema` вимагає `token: 'string <= 60'`, фронтенд завжди передає `props.token` (зазвичай порожній), а сервіс входу його не читає. Без поля вхід дає `422`, що збиває з пантелику при ручних запитах.
- **Пропозиція:** зробити `token?` опційним або прибрати, якщо він ніде не потрібен; задокументувати призначення, якщо потрібен.

### 78. Вхід без CSRF-токена відхиляється при `CSRF_ENFORCE=true`

> **Задокументовано:** потік описано в [`security.md#csrf`](../../documentation/backend/security.md#csrf) і гайдах «CSRF простими словами» та «Швидкий старт». Окремого режиму для не-браузерних клієнтів немає — без конкретної вимоги не робимо.

- **Що:** `POST /api/auth/login` без попереднього `GET /api/main/init` дає `CSRF validation failed, reason: token_mismatch` (при `CSRF_ENFORCE=false` лише WARN). Для браузера це коректно, бо фронтенд спершу викликає `init`, але для API-клієнтів (мобільний застосунок, інтеграційні тести) поведінка неочевидна.
- **Пропозиція:** описати в `auth-security.md` (зроблено в гайді «Швидкий старт»); за потреби — окремий режим для не-браузерних клієнтів.

### 79. `admin_guard` відповідає не в канонічному форматі помилки

> **Виправлено** (feat-085): HTTP `admin_guard` відповідає `403 {"status":"error","code":"forbidden",...}` через `forbidden()` + `appErrorToPayload`; `ws-admin-guard` уже використовував канонічну помилку.

- **Що:** звичайний користувач на `GET /api/admin/users` отримує `403 {"status":"forbidden","message":"Admin access required","csrfToken":"..."}`. Решта помилок мають `{"status":"error","code":"<code>","message":...}` (`CanonicalErrorResponseSchema`), тож клієнт, що перевіряє `status === 'error'` або `code`, цю відмову не розпізнає.
- **Пропозиція:** формувати відповідь `admin_guard` (і `ws-admin-guard`) через `forbidden()` з `errors.ts`, щоб отримати `status: 'error'`, `code: 'forbidden'`.

### 80. Туторіал «Як додати фічу» порушував правило шарів

- **Що:** крок 5 імпортував `NoteRow` з `#app/repositories/note/note-repository.js`, а `layering.spec.ts` дозволяє поза `app/repositories` лише barrel. Код туторіалу, перенесений дослівно, давав червоний `pnpm test`.
- **Виправлено** в документації: імпорт з `#app/repositories/index.js`, повний `pnpm --filter backend test` зелений (124 файли, 920 тестів на момент перевірки).
