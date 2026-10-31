# Code review `main` — безпека, дублювання, складність

- **Дата:** 2026-10-31
- **Коміт:** `a82b65a` (Merge PR #186), робоче дерево чисте
- **Обсяг:** ~48k рядків у 428 файлах (`packages/backend`, `packages/frontend`, `packages/api-playground`, `packages/shared`, config/CI)
- **Метод:** чотири паралельні рев'юери (backend security, backend дублювання/складність, frontend + api-playground, shared/config/CI) + ручна перевірка топових знахідок у коді.

Базовий шлях для посилань: `packages/backend/src/`, якщо не вказано інше.

---

## 🔴 Безпека — потребує виправлення

### 1. IDOR у push-підписках — HIGH, підтверджено

`app/repositories/notifications/push-subscription-repository.ts:141-147, 166-172` — `update()` і `deactivate()` роблять `WHERE id AND userId`, але потім повертають `findById(id)` **без** `userId`. Сервіс (`app/services/notifications/push-subscription-service.ts:190-197`) вважає будь-який рядок успіхом, трансформер (`app/transformers/push-subscription-transformer.ts:31-41`) віддає `...rest` (endpoint, p256dh/auth ключі, IP, UA, пристрій).

**Сценарій:** будь-який залогінений юзер робить `PUT /api/push-subscriptions/<N>` з `{}` → UPDATE зачіпає 0 рядків, відповідь 200 з чужим записом. `bigserial` id легко перебираються. `GET /:id`, `DELETE`, логи і статистика скоуплені правильно — проблема тільки в цих двох шляхах.

**Фікс:** `.returning()` + порожній результат = 404, або повторне читання через `findByIdAndUserId(id, userId)`. Додати spec: update/deactivate чужого id → 404.

### 2. Зміна пароля не вбиває інші сесії — MEDIUM, підтверджено

`app/services/auth/auth-service.ts:1268-1353` (`changePassword`) оновлює лише `password`; контролер (`auth-controller.ts:226`) потім викликає `renewSession` (`auth-service.ts:1210-1243`), який робить `auth.login(userId, userToken)` з **тим самим** `userToken` — усі інші Redis-сесії `session:<userToken>:*` залишаються живими. Для порівняння `password-reset-service.ts:616-639` робить `sessionToken: nanoid()` + `destroyAllSessions(previousSessionToken)`.

**Сценарій:** вкрадена session cookie працює ще до 24h (sliding) після того, як жертва змінила пароль.

**Фікс:** у `changePassword` ротувати `sessionToken` і викликати `destroyAllSessions(previousToken, currentSessionId)`, потім `renewSession` з новим токеном. Задокументувати в `documentation/backend/auth.md`.

### 3. Support-чат без обмежень розміру і LLM-бюджету — MEDIUM, підтверджено

`packages/shared/src/schemas/support/support-chat.ts:4` — `message: 'string >= 1'`, максимуму немає (WS-кадр до 1 MB, `vendor/start/server.ts:115`). `app/services/support/support-service.ts:174-199`: кожне повідомлення зберігається, перекладається (LLM), ембедиться (LLM) і шлеться з останніми 20 повідомленнями в промпті (`support-llm-service.ts:87-92`). Єдиний ліміт — 60/хв per-IP (`app/routes/ws-routes.ts:47`); per-user throttle і перевірки `llm_text_usage` немає. `getChatHistory` (`support-repository.ts:31-41`) теж необмежений.

**Фікс:** `message: 'string >= 1 & string <= 4000'`, Redis-throttle policy по userId для `support_chat`/`support_open_chat`, денний токен-бюджет через `llm_text_usage`.

### 4. Multipart буферизується до 50 MB у RAM до feature-лімітів — MEDIUM

`vendor/utils/network/http-request-handlers.ts:28-41, 110-129` — глобальний `maxMultipartBodySize` = 52 428 800 (`config/app.ts:83`), `server.ts:260-270` відхиляє тільки `Content-Length > limit`. Аватар 10 MB (`avatar-service.ts:20,65`) і KB-скріншот 5 MB (`knowledge-base-service.ts:23,239`) перевіряються **після** повного читання тіла. Група `avatar` (`http-routes.ts:376-398`) без route `rateLimit`, лише глобальний 600/хв/IP.

**Фікс:** per-route `maxBodySize` (опція route, яку читає `readAndParseBody`): avatar = 10 MB, KB = 5 MB; `rateLimit` на групу avatar.

### 5. OAuth access/refresh токени провайдерів у plaintext і ніколи не читаються — MEDIUM

`database/schema.ts:268-269` (`accessToken`, `refreshToken` text), пишуться в `app/services/auth/oauth-service.ts:324-331, 387-398, 426-437` через `oauthAccountRepository.updateTokens`. Жоден код їх не читає — user-info запити використовують токен з пам'яті в callback. Також `oauth-service.ts:113-115` шле Facebook access token як `?access_token=` у query-рядку (потрапляє в логи проксі/egress).

**Фікс:** не зберігати (`null`, прибрати колонки + `updateTokens` міграцією) або шифрувати ключем, окремим від `APP_KEY`; Facebook token передавати в `Authorization: Bearer`.

### LOW

- **Логін підтверджує пароль для неверифікованого акаунту.** `auth-service.ts:1155-1174`: неправильний пароль → 401 «Invalid email or password»; правильний + unverified → 400 «Email verification required». Розкриває існування акаунту і правильність пароля до верифікації. Фікс: generic 401, підказку «verify your email» — тільки листом.
- **Email-exists timing oracle на strict registration.** `auth-service.ts:337-342` повертає generic message одразу для існуючого email, а для нового — продовжує до scrypt-хешу + insert. Фікс: хешувати перед lookup (як `forgotPassword`).
- **Роль адміна для WS кешується на весь час з'єднання.** `app/websocket/ws-coordinator.ts:21-24` читає роль при connect; `ws-admin-guard.ts:11` і `admin-ws-channel-service.ts:16` перевіряють лише `userData.role`. Ping тримає сокет вічно (`ws-handlers.ts:215-223`) — demoted admin зберігає канал `admin` до reconnect. HTTP-адмін-роути перечитують DB на кожен запит (`admin-guard.ts:14`). Фікс: re-resolve ролі в `ws_admin_guard` з коротким TTL або закривати admin-сокети при зміні ролі.
- **`database/db.ts:17` `ssl: false` hardcoded; `:31` SQL-логування з параметрами** при будь-якому `APP_ENV`, крім `prod|production` — `APP_IS_PRODUCTION=true` з кастомною назвою env (що рекомендує `.env.example`) логує кожен statement із хешами паролів/токенів. Фікс: `PGSQL_SSL` env; logger за `appConfig.isProductionLike`.
- **Повні діалоги support зберігаються в `llm_text_usage.final_prompt`** (`ai/types.ts:57-59`, `llm-usage-service.ts:27-43`) і віддаються адмінам через `/admin/usage/text` (`llm-usage-controller.ts:43`); `oauth-service.ts:284-287, 296, 406` логує email/name на рівні info. Фікс: зберігати hash/довжину або truncated prompt; `maskEmailForLogs` вже існує.
- **`packages/frontend/src/views/UserAccount.vue:391-405, 420, 450`** — п'ять `type="password"` без `autocomplete`; браузер може автозаповнити збережений пароль у поле «новий». Фікс: `current-password` / `new-password` + `name`. (`AuthModals.vue` і `ResetPasswordView.vue` — правильно.)
- **`packages/frontend/src/service-worker.ts:494-518`** — `notificationclick` відкриває `event.notification.data?.url` без same-origin перевірки; `client.url.includes(url)` — substring. Фікс: `new URL(url, self.location.origin).origin === self.location.origin ? url : '/'`.
- **GitHub Actions пінуються на мутабельні теги** (`@v4`, `@v3`, `@v5`) у `ci.yml`, `docs.yml`, `pg-tests.yml`, `redis-tests.yml`; deploy-job має `pages: write` + `id-token: write`. Фікс: SHA + коментар версії, Dependabot.
- **api-playground (dev tool):** `stores/api-settings.ts:95` пише `globalHeaders` (куди вставляють `Authorization: Bearer …`) у `localStorage`; `utils/base-api.ts:91-96` `console.log` headers і body на кожен запит, `vite.config.ts` без strip console. Фікс: значення в пам'яті/`sessionStorage`, редакція `authorization|cookie|.*token`.

---

## 🟡 Дублювання

### Backend — три auth-сервіси (~2.3–2.6k рядків, ~10% backend)

| #   | Що                                                                                                                                                                                                                                                                                                     | Де                                                                                                                                                                                                                                   | Пропозиція                                                                                                                            | −рядків |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | SMS «start challenge» ×3: gate → `normalizePhone` → throttle IP → throttle phone → cooldown → invalidate → create → `issueVerificationCode` → `markIssued` → 3 rollback-гілки                                                                                                                          | `auth-service.ts:405-562`, `:722-879`, `password-reset-service.ts:326-523`                                                                                                                                                           | `issueSmsChallenge({ flow, phone, ipPolicy, ipAddress, sessionId, metadata })` в `app/services/auth/sms-challenge.ts`                 | ~300    |
| 2   | SMS «confirm» ×3: throttle → `findById` + flow check → invalidated/confirmed/expired → `verifyOtpVerificationCode` → `incrementAttemptCount` → `markInvalidated` при `>= smsMaxInvalidAttempts` → `markConfirmed`                                                                                      | `auth-service.ts:564-640`, `:881-1014`, `password-reset-service.ts:661-798`                                                                                                                                                          | `verifySmsChallenge(challengeId, code, flow, ipPolicy): AppResult<SmsAuthChallengeRow>`                                               | ~110    |
| 3   | Одноразові токени ×3: репозиторії `password-reset-repository.ts` / `email-verification-repository.ts` / `email-link-verification-repository.ts` побайтово ідентичні; три таблиці `userId/tokenHash/expiresAt/usedAt` (`schema.ts:172-225`); `hashToken`+`createToken` і issue/consume-флоу скопійовані | `password-reset-service.ts:64-70, 269-324, 544-580`; `email-verification-service.ts:37-43, 247-306, 323-365, 432-446, 553-610`                                                                                                       | `createTokenRepository(table)` + `one-time-token.ts` з `hashToken`, `issueToken`, `consumeToken`                                      | ~230    |
| 4   | HTML email-шаблони ×3 + `EMAIL_BRAND` і `escapeHtml` по 2 копії                                                                                                                                                                                                                                        | `password-reset-service.ts:52-62, 103-110, 137-215`; `email-verification-service.ts:25-35, 131-138, 73-126, 163-241`                                                                                                                 | `app/services/notifications/email-templates.ts` → `renderBrandedEmail({ preheader, eyebrow, heading, intro, ctaLabel, url, footer })` | ~230    |
| 5   | Throttle-boilerplate `tryInternal → isError → !allowed → badRequest` **32 рази** по 10 рядків (13 з однаковим текстом); `normalizePhone`/`normalizeEmail`/`isChallengeExpired`/`LINK_PHONE_FLOW` по 2 копії                                                                                            | `auth-service.ts:55,75,110,114` vs `password-reset-service.ts:50,80,92`; inline `.trim().toLowerCase()` у `password-reset-service.ts:225`, `email-verification-service.ts:381,398`, `oauth-service.ts:294`; `db/seed/run-seed.ts:65` | `enforceThrottle(policy, key, msg): Promise<AppResult<void>>` + `auth-normalize.ts` (або `shared/utils`)                              | ~220    |

### Backend — інше

- **Env-парсери по кожному config-файлу з різною семантикою.** `config/auth.ts:1-7` `parseBooleanFlag` приймає `'1'|'true'`; `config/network.ts:3` — ще один; `vendor/utils/env/parse-boolean.ts` — `'true'|'1'|'yes'|'on'`. Тож `AUTH_PHONE_ENABLED=yes` = false, а `SERVE_STATIC=yes` = true. `readInt` (`throttle-policies.ts:29`), `readInteger` (`rate-limit.ts:11`), `readTimeoutMs`/`readPromptCacheTtlMs` (`ai.ts:20-30, 48-58`), `parseSize`/`parsePort` (`app.ts:27,37`, `mail.ts:8`) — одне й те саме; `config/auth.ts:9-16` `parseNumberFlag` через голий `Number()` (приймає `1e3`, `0x10`, від'ємні) і не йде через `validate-runtime-config.ts`. Фікс: `vendor/utils/env/read-int.ts` → `readInt(env, name, fallback, { min, max, errors })`, всюди `parseBoolean`. ~−70.
- `app/services/support/knowledge-base-service.ts` — «load article or 404» ×7 (`:329-341, 383-393, 428-438, 481-491, 542-552, 588-596, 623-633`), «delete screenshot, warn on failure» ×3 (`:441-453, 494-506, 555-567`). Фікс: `requireArticle(id)`, `deleteScreenshotQuietly(key)`. ~−70.
- `appErrorToHttpPayload` (`apply-service-status.ts:30-39`) ≡ `appErrorToWsError` (`ws-error.ts:11-20`). ~−15.
- `normalizePath`: `config/app.ts:9` і `http-request-handlers.ts:251`; `ab2str`: `ws-handlers.ts:133` і `get-ip.ts:5`.
- `oauth-service.ts:11-29` `fetchJson`/`fetchJsonArray` — одна функція з різним кастом.

### Frontend / api-playground

- **Два `useWebSocketConnection.ts`** (`packages/frontend/src/composables/` 447 рядків, `packages/api-playground/src/composables/` 437) — ~275 рядків побайтово ідентичні (open/close, pending-request map, токен у `Sec-WebSocket-Protocol`, decode, reconnect timer). Playground дублює типи `WebsocketMessage`/`ApiResolveItem`/`ApiError` inline; `classifyWsMessage` ідентичний у `frontend/src/utils/ws-api-response.ts:39-51` і `api-playground/src/utils/ws-message-kind.ts:1-13`; `utils/api-path.ts` і `utils/event-bus.ts` є в обох. Фікс: транспорт + типи + `classifyWsMessage` + `api-path` у `packages/shared` (або `packages/ws-client`), в апках — тільки хуки.
- **Правила пароля ×6 з трьома різними наборами.** `AuthModals.vue:201, 397-402, 470-475, 635-640` — лише min 8 (40-символьний пароль проходить до 422); `ResetPasswordView.vue:39-56` і `UserAccount.vue:138-143` — 8–32. Джерело істини вже є: `shared/src/schemas/auth/{register,login,change-password}.ts` = `'string >= 8 & string <= 32'`. Фікс: одна `validatePassword(pw, confirm)` зі shared-схем.
- `AuthModals.vue:82-86` — власні `isEmail` і `looksLikePhoneNumber` з тим самим regex, що `shared/src/utils/phone.ts:26`.
- **Admin-view'и:** `AdminUsersView.vue:9-57` і `AdminHistoryOnlineView.vue:9-89` — однаковий filter state/reset/param builder (та ж дублікація в `utils/api.ts:519-535` / `:552-571`); `openUserModal` ×3 (`AdminUsersView.vue:72`, `AdminHistoryOnlineView.vue:94`, `AdminUserOnlineView.vue:72`); 68 ідентичних рядків CSS. Фікс: `useAdminUserDetailModal()`, `AdminFilterBar.vue`, `admin.css`, `buildAdminQuery()`.
- `utils/sentry-service.ts:100-175` — `sanitizeRequestData` і `sanitizeBreadcrumbData` — один recursive walker з різницею drop vs `[Filtered]`; `beforeSend` (`:241-247`) повторно проганяє breadcrumbs, які вже пройшли `beforeBreadcrumb`; `composables/useSentry.ts` — 3-рядковий `return sentryService`.
- **17 locale-файлів** (`locales/{ar,cs,de,...}.ts`) — 3-рядкові `export default en`; `plugins/i18n.ts:46-54` робить `mergeLocaleMessages(en, en)`; UI рекламує 18 мов при одній реальній.
- `TestFormWs.vue` копіює `findScrollContainer`/`scrollToResponse`/`validateBody`/`responseBodyDisplay` з `TestForm.vue`.

### Shared

- `packages/shared/src/brands/` (`primitives.ts` 6 схем + `ids.ts` `EntityIdSchema`) — **0 production-споживачів** (тільки `shared-brands.spec.ts` і мертвий `activity/user-activity.ts`), а його regex переписаний у `backend/src/vendor/utils/helpers/entity-id.ts:1` і `frontend/src/utils/ws-payload-guards.ts:16` (коментар «Mirrors EntityIdSchema»). Фікс: або імпортувати `EntityIdSchema` в обох, або видалити `brands/` + export у `shared/package.json`.
- `schemas/auth/register.ts` (`RegisterInputSchema`) побайтово ≡ `register-email.ts`; використовується лише другий (`http-routes.ts:71`). Видалити.
- `schemas/activity/user-activity.ts` — 3 схеми з іншого продукту (`clickBooking`, `countClick`, російські коментарі), 0 споживачів. Видалити.
- `PaginationQuerySchema`, `DateRangeQuerySchema`, `CursorQuerySchema`, `PositiveIntFromString` (`schemas/query/common.ts:68-84`) — експортовані, використовуються лише в `pagination.spec.ts`.
- `errors/error-codes.ts:4-37` (`ErrorCode` + `ErrorCodeValues`) і `csrf-reasons.ts:4-16` — enum і масив вручну, з тестом на синхронізацію (`shared/test/contracts.test.js:16-24`). Фікс: `Object.values(ErrorCode)` + `as const satisfies`, тест прибрати.
- `normalizeEmail` продубльований у `db/seed/run-seed.ts:65` з коментарем «Same normalization as … auth-service.ts». Фікс: у `shared/utils`.

---

## 🟠 Надмірна складність / мертвий код

### Backend

- **`vendor/utils/helpers/normalize-user-id.ts` — 219 рядків, 0 викликів.** Єдина згадка — barrel `helpers/index.ts:8`, який теж ніхто не імпортує; ще 25 рядків копії закоментовано в `redis-session-storage.ts:10-43`. Також без викликів `toCanonicalEntityId`/`isAuthorizedEntityRequest` в `entity-id.ts`. ~−275.
- **`app/middlewares/test-middleware{,-2,-3,-4}.ts`** зареєстровані в `kernel.ts:20-23`, жоден route не використовує `test1..test4`. ~−60.
- **Експортовані, але невикористані:** `getTypedQuery`/`isHttpContext`/`isWsContext` (`vendor/utils/validation/get-typed-payload.ts:22-67`); `app/services/shared/session-access.ts` цілком (`resolveActorAuth`, `resolveResourceOwnership`); `applyAppError` (`apply-service-status.ts:41-44`); `tryDomain` (`result-helpers.ts:20-27`); `APP_ERROR_CASES` (spec-only); `staticIndexHandler` (`static-server.ts:211-223`); `RequestSchema`, `ResponseSchema`, `RouteHandler`, `HttpController`, `WsMiddleware` у `vendor/types/types.d.ts`; `app/validate/schemas/common/pagination.ts` — чистий ре-експорт без імпортерів, але зі 105-рядковим spec; `arktype-inference.spec.ts` (260 рядків) тестує ArkType, а не проєкт; закоментований код в `index.ts:4,8-9,21-36`, `ws-context.ts:12-28,42-45`, `session-handler.ts:1-2,55-61`. ~−520 разом зі spec'ами.
- **`vendor/utils/routing/serialize-routes.ts:866-951`** обробляє три форми `describe()` «для адаптера, що сам серіалізує схеми» — існує лише `arkValidator`. Плюс `isSchemaField/isJsonSchema/jsonSchemaType/jsonSchemaFields` і 90 рядків spec (`serialize-routes.spec.ts:699-792`). ~−150.
- **`vendor/start/server.ts:390-483`** — 6 ad-hoc error-класів (`PayloadTooLargeError`, `RedisUnavailableError`, `MalformedBodyError`, `UnsupportedMediaTypeError`, `ValidationError`, `ParameterValidationError`) і `instanceof`-драбина, кожна гілка повторює `sendErrorResponse(...)`. `ParameterValidationError` (`app/validate/checkers/parameter-checker.ts:8-21`) живе в app-шарі, але кидається/ловиться тільки vendor-кодом. Фікс: базовий `HttpError { statusCode, code, logLevel, toBody() }`. ~−50.
- **12 repository-інтерфейсів з єдиною реалізацією** (`IUserRepository`, `IPushSubscriptionRepository`, `IPasswordResetRepository`, …) — spec'и мокають модуль, не інтерфейс. Фікс: `as const satisfies`. ~−150.
- **Контролери повторно перевіряють auth, яку вже забезпечив `auth_guard`** — 28 місць. `push-subscription-controller.ts:44-56` `resolveUserId` пише 401 і повертає null, а 9 викликів потім ще раз мапять `unauthorized()`; `auth-controller.ts:215-224` перевіряє `auth.check()` і `getUserId() === null`. Фікс: `requireUserId(context): bigint` в `controllers/shared/`. ~−90.

### Frontend

- **`AuthModals.vue` — 1706 рядків** (715 script / ~500 template / 490 style): 2 модалки (`:718`, `:921`) × 8 станів (`loginStep` 3, `registerStep` 5), 40 `ref` (`:42-80`), два ручних reset'и на 17 і 19 ref'ів (`:94-137`), блок `loading=true / try { if (error||hasResponseError) … } catch … finally` ×7 (`:209-254, 299-371, 410-443, 488-528, 547-578, 590-618, 653-687`), «signed-in tail» ×3 (`:238-245, 507-514, 671-678`). Фікс: `LoginModal.vue`, `ForgotPasswordFlow.vue`, `RegisterEmailForm.vue`, `RegisterPhoneFlow.vue` на спільному shell; `reactive()` state; `runAuthRequest()` + `completeSignIn()`. (`views/Login.vue` — не дублікат, це landing, що хостить `<AuthModals>`.)
- **`stores/state.ts` (565)** — UI-prefs (`:17-30, 480-560`) + storage-URL builder (`:56-96`) + весь push-стек (`:120-470`) включно з ~90 рядками UA-sniffing (`getBrowserInfo` `:271-297`, `getOSInfo` `:300-330`, `getDeviceType` `:262-268`), хоча `navigator.userAgent` і так надсилається (`:345`); `getClientIP` — stub (`:335`). Фікс: `usePushSubscriptions()`, UA-парсинг на сервері.
- **`main.ts:48-401`** — `ServiceWorkerManager`, MessageChannel handshake (`:137-173`), два дублюючі «should I notify» гейти (`:291-306`, `:308-349`), мертва гілка `event.data === 'NEW_VERSION'` (`:368` — SW шле тільки об'єкт, `service-worker.ts:268-271`). Фікс: `utils/sw-manager.ts` з одним `shouldNotify()`.
- **`MenuButton.vue` (752)** тримає `<pwa-install>` bridge (ref, 2 DOM listeners, 3 watchers, accent sync `:28-170`). Фікс: `PwaInstallButton.vue`.
- **`api-playground/.../TestForm.vue` (859)** — load-test engine inline (`sendRequest` ~200 рядків, single/sequential/threaded), `testResult: any` (`:41`), single-thread loop дублює `executeThread`. Фікс: `useLoadTest()` з типізованим `SingleResult | BatchResult`.

### Shared

- **ArkType tuple-default cast workaround** `[LimitIntFromString, '=', '50'] as unknown as 'string.integer.parse'` + ручні `…Output`/`…Input` інтерфейси скопійовані у `schemas/query/common.ts:19-32`, `admin.ts:22-27, 43-49`, `usage.ts:31-37` — типи можуть мовчки розійтися зі схемами. Фікс: `withDefault(schema, '50')` helper або перевірити, чи `@arktype/type` 2.2.9 вже типізує `.default('50')`.

---

## 🔵 Гігієна

- `progress.md` і `session-handoff.md` лежать на `main` (`Active Feature: feat-057`, `Branch: fix/anonymous-session-flood` — вже `done`), хоча `AGENTS.md:6,17` каже, що вони живуть тільки на feature-гілці. Видалити з `main` або оновити AGENTS.md.
- `.gitignore` не покриває `.pnpm-store/` (директорія вже є в корені, поки порожня); `.dockerignore` пропускає `.claude/` (із `settings.local.json`), `.idea/`, `.omx/`, `.pnpm-store/`, `docs/plan/`, `presentation.html` у build-контекст (`Dockerfile:33` `COPY . .`). У фінальний image не потрапляє, але роздуває контекст.
- `eslint.config.ts:11-12` ігнорує всі `**/*.js` і `**/*.mjs` — `backend/src/scripts/copy-static.js`, `documentation/scripts/verify-dist.mjs`, `shared/test/*.test.js` не лінтяться.
- Три дерева презентацій: `presentation.html` у корені (37 KB), `docs/presentations/PRESENTATION.html`, `PRESENTATION-CONTEXT.html`; `docs/screenshots/README.md:1` посилається на кореневий. `docs/` (45 md) vs `documentation/` (VitePress) — не задокументовано, що з них публічне.
- Схема: `llm_text_usage.user_id` `onDelete: 'cascade'` (`schema.ts:305-307`), тоді як `push_notifications_log.user_id` — `set null` (`:150-152`); `support_chat_history` індекс лише по `user_id` (`:360`), а запит — `user_id + ORDER BY created_at DESC` (`support-repository.ts:32-36`).
- `api.ts:546` `admin/users-online/${id}` — єдиний admin-шлях без `encodeURIComponent` (косметика, id серверний).

---

## ✅ Перевірено і в порядку

- **Сесії:** login/register/OAuth callback/password change створюють новий session id + CSRF і видаляють старий (`session-handler.ts:327-370`); `__Host-` cookie в production, HttpOnly/Secure/SameSite=Lax; HMAC-SHA256 підписи з `timingSafeEqual`.
- **CSRF:** Fetch-Metadata → точний Origin/Referer allow-list (обов'язковий в production) → per-session token з `timingSafeEqual` на кожен unsafe method; login CSRF покритий анонімною сесією.
- **Токени:** reset/verify/link — 256-bit `randomBytes`, SHA-256 at rest, single-use, TTL, старі інвалідуються; `forgotPassword` відповідає однаково і шле в фоні; обидва reset-флоу ротують `sessionToken`. OTP — HMAC, constant-time, attempt cap, прив'язка до сесії; fake SMS provider заборонений у production-like (`validate-runtime-config.ts:109-125`).
- **IP / rate-limit:** `X-Forwarded-For`/`X-Real-IP` лише з `TRUSTED_PROXY_CIDRS`, rightmost-untrusted walk; rate limits до читання body; auth-throttle — атомарний Redis INCR до lookup'ів, fail-closed.
- **Routes:** усі `admin/*` і `prompts/*` — `auth_guard` + `admin_guard` з DB-перевіркою ролі на кожен запит; support/avatar/push — `auth_guard`; усі запити параметризовані Drizzle (єдиний `sql`` ` з input — `LOWER(${email})`, параметризований); admin list capped 100/200.
- **Static server:** лише pre-cached шляхи, `..`/`%2e%2e`/NUL відхиляються, SPA fallback; nosniff, X-Frame-Options DENY, no-referrer, HSTS, CSP; `no-store` на API; CORS віддзеркалює лише точні origins.
- **Uploads:** magic-byte sniffing має збігатися з declared type, extension із detected type, UUID-ключі, client filename не використовується; frontend валідує size/type і перекодовує в 512px WebP.
- **WebSocket:** upgrade через 95-bit токен, прив'язаний до session+user у Redis (60–120 s TTL), в `Sec-WebSocket-Protocol`, а не в URL; дворівневий upgrade rate limit; сесія перевіряється на кожне повідомлення; broadcast channels allow-listed.
- **Frontend:** 0 `v-html`/`innerHTML`/`eval`/`new Function`; нічого auth-related у `localStorage`; CSRF token у пам'яті модуля; SW не кешує API (`sw-request-policy.ts:43-46`), шанує `no-store`/`private`, реєструється лише в PROD; `?redirect=` не є open redirect (vue-router резолвить відносно поточного route); тільки `VITE_*` потрапляє в bundle; Sentry без PII, console.log вирізається в prod.
- **Інфра:** жодних секретів у git і в історії (`.env`/`.pem`/`.key` ніколи не додавались); `backend/public/` в `.gitignore`, не комітиться; міграції синхронні зі схемою (`drizzle-kit generate` → «No schema changes»); token-таблиці зберігають `token_hash`, SMS — `code_hash`, `users.email` з partial `LOWER(email)` unique index; seed без hardcoded-паролів; Dockerfile multi-stage, non-root `app`, healthcheck; CI з `permissions: contents: read`, без `pull_request_target`; `patches/uWebSockets.js` — однорядковий ESM-fix, задокументований; S3 CORS — лише GET/HEAD з явних origins.

---

## Рекомендований порядок

1. **Зараз:** IDOR (#1) і ротація сесій при зміні пароля (#2) — обидва маленькі фікси + spec.
2. **Наступний PR:** support-чат ліміти (#3), per-route body size (#4), OAuth-токени (#5).
3. **Чистка мертвого коду** (`normalize-user-id`, test-middlewares, невикористані експорти, `shared/brands`, `register.ts`, `user-activity.ts`) — безпечний PR на ~−900 рядків, можна робити першим.
4. **Рефакторинг auth-сервісів** як окремий feature у `feature_list.json`: `sms-challenge.ts` + `one-time-token.ts` + `email-templates.ts` + `enforceThrottle()` — знімає ~1000 рядків із трьох найбільших файлів.
5. **Frontend:** WS-транспорт у shared, розбити `AuthModals.vue`, одна `validatePassword` зі shared-схем, `autocomplete` на password-полях.
