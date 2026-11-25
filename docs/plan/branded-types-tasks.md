# Branded types і value objects — покроковий task list (v2)

Джерело: [`branded-types-plan.md`](./branded-types-plan.md) (редакція 5, рішення Р1–Р13). Базовий шлях:
`packages/backend/src/`, якщо не вказано інше. Коміт для посилань на рядки: `e298f08`.

**v2.1:** модулі, які імпортує `database/schema.ts` (зокрема `newSessionToken` для `$defaultFn`), не мають
`#`-імпортів, бо drizzle-kit виконує схему без аліасів. HMAC `mfaBinding` лишається в `mfa-ticket.ts` (T16, T30, T31).

**v2 — після рев'ю task list:**

- Усі конструктори брендів (id, секрети, email) живуть у `app/domain/`, тож виняток `no-brand-cast` за шляхом
  покриває їх без `services/**` (T16, T28–T30, T34).
- `parseEntityId` видаляється в T25.
- У T19, T31, T42 додано пропущені пункти DoD (`docs:verify`, `db:generate`), у T41 — скіл `scheduled-job`.
- Уточнено:
    - імена брендів PK `user_online` і `mfa_recovery_codes`;
    - `decodeAuditCursor` → `AuditEventId`;
    - `$type` на всіх колонках хешів;
    - тести типів для `mfa_bind` і OTP;
    - колонки `target_email`;
    - чистка `brands/index.ts`;
    - helper-и для всіх брендів feat-268.

Кожна фіча має окремий рядок у `feature_list.json`, гілку і PR (правила `AGENTS.md`). Задача T* — це один коміт або
кілька дрібних, і вона закінчується зеленим вузьким тестом свого рівня.

Позначення тестів:

- `*.spec.ts` — `pnpm --filter backend test`
- `*.redis.test.ts` — `make test-redis`
- `*.pg.test.ts` — `make test-pg`
- `shared/test/*.test.js` — `pnpm --filter shared test`
- frontend `__tests__` — `pnpm --filter frontend test`

Тести типів — це файли `*.spec.ts` з `@ts-expect-error`, і їх ловить `typecheck`.

**Definition of Done для кожної фічі** записується в `feature-state/<feat-id>/progress.md` → Evidence of Completion:

- `make check`;
- `make test-pg` і/або `make test-redis` з кількістю виконаних і пропущених тестів (або посилання на CI-джоби
  `test-pg` / `test-redis`);
- `pnpm --filter backend db:generate` без нової міграції, якщо змінено `database/schema.ts`;
- `pnpm docs:build && pnpm docs:verify`, якщо змінено `documentation/`;
- ручна перевірка golden path.

## Відповідність і порядок

| Фіча       | Гілка                            | Задачі  | Залежить від |
| ---------- | -------------------------------- | ------- | ------------ |
| `feat-262` | `fix/single-entity-id-validator` | T1–T9   | —            |
| `feat-263` | `feat/branded-ids-auth`          | T10–T20 | `feat-262`   |
| `feat-264` | `feat/branded-ids-domains`       | T21–T26 | `feat-263`   |
| `feat-265` | `feat/branded-secrets`           | T27–T32 | `feat-263`   |
| `feat-266` | `feat/normalized-email`          | T33–T36 | `feat-263`   |
| `feat-267` | `feat/branded-time-units`        | T37–T42 | `feat-262`   |
| `feat-268` | `feat/shared-frontend-brands`    | T43–T48 | `feat-263`   |

Усі фічі належать одному власнику, а `AGENTS.md` дозволяє одну активну фічу на власника. Тому порядок за замовчуванням
послідовний: `feat-262` → `feat-263` → `feat-264` → `feat-265` → `feat-266` → `feat-267` → `feat-268`.

- `feat-267` можна взяти одразу після `feat-262`, якщо зручніше. Вона не залежить від `feat-263`, а правило
  `no-brand-cast` (Р10) пізніше розпізнає бренди часу за формою типу.
- Паралельна робота можлива лише тоді, коли фічу перед стартом передано іншому власнику (PR до `main`, що змінює
  `owner`).

Кожна фіча починається з однакового кроку **«Старт»**:

1. PR до `main` з короткої гілки `chore/feat-XXX-start`: статус → `in_progress`.
2. Гілка фічі від `main`, файли `feature-state/<feat-id>/progress.md` і `session-handoff.md`.
3. `./init.sh` зелений, результат записано в `progress.md`.

Закінчується кожна фіча кроком **«Закриття»**:

1. Evidence of Completion у `progress.md`, статус → `review`.
2. Мерж PR реалізації.
3. PR «Mark feat-XXX done»: статус `done`, `evidence`, видалення `feature-state/<feat-id>/`.

---

## feat-262 · Спільний валідатор id

### T1 · Старт

- [ ] Крок «Старт» для `feat-262`.

### T2 · Зафіксувати поточну поведінку (колонка «Зараз»)

- [ ] PG-тести маршрутів з таблиці feat-262 плану на `'0'`, `'007'`, `9223372036854775808`. Тести фіксують **поточні**
      відповіді, ще до зміни коду (`app/controllers/http/**/*.pg.test.ts` поруч із наявними тестами маршрутів).
- [ ] Якщо фактична відповідь відрізняється від колонки «Зараз», виправити таблицю в плані тим самим комітом.
- [ ] Цей коміт не змінює продакшн-код. Наступні задачі переписують очікування тестів на колонку «Після».

### T3 · `shared/brand`: `Brand` і `isValidEntityId` — Р2, Р4

- [ ] `packages/shared/src/brand/index.ts`: `Brand<T, Id> = T & { readonly ' brand': [T, Id] }` і
      `isValidEntityId(value: string): boolean`. Функція перевіряє `ENTITY_ID_PATTERN` і межу
      `value.length < 19 || value <= '9223372036854775807'`. Модуль не імпортує жодного пакета.
- [ ] `packages/shared/package.json`: export `./brand` (`shared-source`, `types`, `import`) за взірцем `./brands`.
- [ ] `shared/src/patterns/index.ts`: `ENTITY_ID_PATTERN = /^[1-9]\d{0,18}$/`.
- [ ] Тест типів у `shared` або `backend/src/app/shared-brands.spec.ts`: двостороння рівність
      `AssertEqual<Brand<string, 'EntityId'>, typeof EntityIdSchema.infer>`, за взірцем `schemas/query/types.ts:33-35`.
- [ ] Тести `isValidEntityId`:
    - приймаються `'1'` і `'9223372036854775807'`;
    - відкидаються `'9223372036854775808'`, `'9999999999999999999'`, `'0'`, `'007'`, `'-5'`, `'0x10'`, `'abc'`, `''`,
      `' 1'`, `'1 '`.

### T4 · Схеми: `EntityIdStringSchema` і прибирання дублікатів — Р4

- [ ] `shared/src/brands/ids.ts`:
      `EntityIdStringSchema = type(ENTITY_ID_PATTERN).narrow(isValidEntityId)` і
      `EntityIdSchema = EntityIdStringSchema.brand('EntityId')`.
- [ ] На `EntityIdStringSchema` переходять:
    - `query/support.ts:14` (`before?`);
    - `query/admin-audit-events.ts:24-25`;
    - `query/notifications.ts:14`;
    - `notifications/requests.ts:10` (`upTo`);
    - `responses/notifications-controller.ts:6` (`IdSchema`).
- [ ] `NOTIFICATION_ID_PATTERN` видаляється разом з його експортом у `schemas/index.ts`.
- [ ] `ProfileRevisionSchema` і frontend `REVISION_PATTERN` **не змінюються**.
- [ ] `shared/test/contracts.test.js:169-174`: паритет `isValidEntityId` з обома схемами. До випадків додаються
      максимум, максимум + 1 і рядки з пробілами.

### T5 · `parseEntityId`, `decodeAuditCursor`, `isCanonicalEntityId`

- [ ] `controllers/shared/parse-id.ts`: `isValidEntityId(raw) ? BigInt(raw) : null`. Власний regex і
      `MAX_POSTGRES_BIGINT` прибираються.
- [ ] `parse-id.spec.ts`: рядок `['0', 0n]` прибирається, а `'0'`, `'007'`, пробіли й максимум + 1 дають `null`.
- [ ] `services/admin/audit-events-query-service.ts:55-64`: id, декодований з курсора, перевіряє `isValidEntityId`.
      `ID_TEXT` і `MAX_POSTGRES_BIGINT` для id прибираються, а перевірка `occurredAt` лишається.
- [ ] `vendor/utils/helpers/entity-id.ts` і його spec видаляються. `generate-ws-token-service.ts:5-8` переходить на
      `isValidEntityId`.
- [ ] `passkey-controller.ts:33` і `notification-controller.ts:28`: перевірка `id > 0n` прибирається.

### T6 · Контролери: unlink і llm-usage

- [ ] `controllers/http/auth/sign-in-methods-controller.ts:29`: `parseEntityId(payload.id)` замість `BigInt`. Схема
      вже відкидає невалідне (422), а `null` тут обробляється як 404, щоб захист не залежав від схеми.
- [ ] `controllers/http/ai/usage/llm-usage-controller.ts:8-15`, за взірцем `admin-user-controller.ts:24-30`:
    - `.trim()` і `try/catch` прибираються;
    - `''` або відсутній параметр означає «без фільтра»;
    - `parseEntityId === null` → `badRequest('userId must be a numeric string')`.
- [ ] `llm-usage-controller.spec.ts`:
    - без `userId` і з `userId=''` фільтра немає;
    - `'abc'`, `' 1'`, `'  '`, `'0x10'`, `'-5'` дають 400.

### T7 · Frontend guard

- [ ] `packages/frontend/src/utils/ws-payload-guards.ts:25`: `isEntityId` викликає `isValidEntityId` зі `shared/brand`.
- [ ] `utils/__tests__/ws-payload-guards.spec.ts`:
    - payload з id `'9223372036854775807'` приймається;
    - `'9223372036854775808'`, `'0'`, `'007'`, `' 1'` відкидаються.
- [ ] `make check` разом із `check-bundle-graph`: імпорт `shared/brand` не тягне ArkType у бандл.

### T8 · Тести маршрутів (колонка «Після») і документація

- [ ] PG-тести з T2 переписуються на колонку «Після». Окремо перевіряються:
    - `cursor=0` і `before=0` на кожному маршруті з курсором;
    - `support` `before=9223372036854775808` дає 422.
- [ ] `documentation/backend/controllers.md` і `documentation/en/backend/controllers.md` (а також інші сторінки з
      `parseEntityId`):
    - формат id: десяткове число без провідних нулів, 1…9223372036854775807;
    - відмова схеми дає 422, відмова контролера — 400 або 404.

### T9 · Закриття

- [ ] DoD: `make check`, `make test-pg` (лічильники), `pnpm --filter frontend test`, `docs:build` + `docs:verify`.
- [ ] Крок «Закриття».

---

## feat-263 · Бренди id: інфраструктура і users/auth

### T10 · Старт

- [ ] Крок «Старт» для `feat-263`.

### T11 · ADR 0007

- [ ] `docs/adr/0007-branded-types.md`:
    - Р1 (бренд, а не клас);
    - Р2 (`shared/brand`);
    - Р3 (бренди за сутностями, `$type` разом із доменом);
    - Р4 (конструктори для кожного бренду, без публічного `parseId<B>`);
    - Р10 (правило «зовнішній рядок стає брендом лише через схему або `parse…`», `no-brand-cast`);
    - Р11 (спершу scope, потім ключ рядка, потім дані; два id одного бренду передаються об'єктом-параметром);
    - Р13 (бренд лише на межі app).

### T12 · Наскрізний сценарій unlink — перевірка Drizzle

- [ ] `database/ids.ts`: `UserId`, `OAuthAccountId`, лише `import type` зі `shared/brand`.
- [ ] `app/domain/ids.ts`: реекспорт, `parseUserId`, `parseOAuthAccountId`, `toEntityId`. Спільна реалізація
      (`isValidEntityId` + `BigInt` + приведення) лишається приватною.
- [ ] `database/schema.ts`: `.$type<UserId>()` на `users.id` і на FK `user_id` таблиці `oauth_accounts`,
      `.$type<OAuthAccountId>()` на `oauth_accounts.id`. Імпорт відносний, через `import type`.
- [ ] Ланцюжок `sign-in-methods-controller` → `sign-in-methods-service` → `oauth-account-repository` приймає бренди.
      `deleteByIdForUser(id, userId)` стає `deleteForUser(userId, id)` (Р11).
- [ ] Критерії, кожен з яких перевірено тестом або `typecheck`:
    - select, insert, `returning`, `eq`, `inArray` компілюються з брендами;
    - RQB v2 (`defineRelations`) працює, поки FK `user_id` інших таблиць ще `bigint`;
    - тест типів: переставлені `UserId` і `OAuthAccountId` не компілюються.
- [ ] `pnpm --filter backend db:generate`: міграції немає.
- [ ] Якщо `defineRelations` вимагає однакового типу на обох кінцях зв'язку, `UserId` разом з усіма FK `user_id` іде
      окремим комітом, і в ньому ж змінюються сигнатури `userId` у доменах feat-264. Рішення записати в `progress.md`.

### T13 · `$type` на решту таблиць auth

- [ ] Бренди і `$type`:
    - `user_preferences` (PK `userId`, бренд `UserId`), `user_online` (`UserOnlineId`);
    - `email_verifications`, `email_link_verifications`, `password_reset_tokens`, `oauth_link_verifications` — один
      бренд `OneTimeTokenRowId`;
    - `totp_factors` (`TotpFactorId`), `mfa_recovery_codes` (`MfaRecoveryCodeId`), `webauthn_credentials` (`PasskeyId`),
      `sms_auth_challenges` (`SmsChallengeId = Brand<string, …>`).
- [ ] Конструктори для кожного бренду в `app/domain/ids.ts`.

### T14 · Сигнатури репозиторіїв і сервісів auth — Р11

- [ ] Репозиторії й сервіси users, sessions, auth, oauth, mfa, passkeys приймають і повертають бренди.
- [ ] Порядок аргументів:
    - `webauthn-credential-repository`: `rename(userId, id, name)`, `deleteOne(userId, id, tx)`;
    - `totp-factor-repository`: `consumeStep(userId, id, step)`.
- [ ] `token-repository.ts` / `one-time-token.ts` працюють з `OneTimeTokenRowId`. Службові приведення на кшталт
      `table as unknown as typeof passwordResetTokens` лишаються як є.
- [ ] Тест типів для кожної пари id, що змінилася.

### T15 · Межа app: сесія — Р13

- [ ] Vendor `SessionData` / `SessionInfo` **не змінюються**.
- [ ] `parseUserId` замість `BigInt(...)` у таких місцях:
    - `controllers/shared/require-user-id.ts:14`;
    - `middlewares/permission-guard.ts:29,51`;
    - `websocket/ws-coordinator.ts:74,88,138`;
    - `websocket/ws-session-auth.ts`: запис WS-токена `:34` і `SessionInfo` `:63`.
- [ ] Невалідний `userId` у сесії означає «без користувача», плюс запис у лог.
- [ ] Запис сесії йде через `toEntityId(userId)`.
- [ ] `auth-service.ts:1100,1176,1204,1230`, `mfa-sign-in.ts` і `session-list-service.ts:47,155`: `BigInt` над рядками
      сесії замінюється на `parseUserId`.
- [ ] Redis-тести (`*.redis.test.ts` поруч із `ws-session-auth` і `request-session`):
    - чинна сесія читається і дає `UserId`;
    - сесія з `userId` `'abc'`, `'0'`, `'9223372036854775808'` вважається без користувача (HTTP і WS);
    - WS-токен з невалідним `userId` відхиляється.

### T16 · Правило ESLint `no-brand-cast` — Р10

- [ ] Локальне правило (наприклад, `eslint-rules/no-brand-cast.ts`) підключається в кореневий `eslint.config.ts`.
- [ ] Логіка правила:
    - для `TSAsExpression` і `TSTypeAssertion` взяти через `parserServices` тип приведення;
    - обійти його члени union / intersection;
    - помилка, якщо серед них є тип із властивістю `' brand'`;
    - у поля об'єктів не спускатися.
- [ ] Винятки за шляхом: `packages/shared/src/brand/**`, `database/ids.ts`, `app/domain/**`, тести.
- [ ] Правило для всіх наступних фіч: **бренд створюється лише в `app/domain/`** (`ids.ts`, а згодом `secrets.ts`,
      `email.ts`, `time.ts`) або в `shared/brand`. Сервіси імпортують конструктори звідти. `services/**` у винятки не
      додається.
- [ ] Модулі `app/domain/**` **не мають `#`-імпортів** (`#config`, `#app`, `#vendor`), лише відносні імпорти,
      `shared/*` і `node:*`. Тоді будь-який з них можна відносно імпортувати в `database/schema.ts`, і drizzle-kit
      не падає. Конструктор, якому потрібен конфіг або інфраструктура, лишається у своєму сервісі й викликає чистий
      конструктор із `app/domain/` (як `mfaBinding` у T30).
- [ ] Тести RuleTester:
    - **помилки:** `x as UserId`, `x as U` (перейменований імпорт), `x as Alias` (`type Alias = UserId`),
      `x as unknown as UserId`, `<UserId>x`, `x as UserId | null`;
    - **не помилки:** `as const`, `as string`, `table as unknown as typeof passwordResetTokens`, `created as Row`.
- [ ] `pnpm lint` зелений на всьому репозиторії.

### T17 · Трансформери auth

- [ ] Трансформери auth/users перетворюють id на рядок через `toEntityId`. Схеми відповідей не змінюються
      (бренди на фронтенді з'являються у feat-268).

### T18 · Tutorial і скіл

- [ ] `documentation/en/backend/adding-a-feature.md` і `documentation/backend/adding-a-feature.md`:
    - бренд id нової сутності в `database/ids.ts`;
    - `$type` у схемі;
    - конструктор у `app/domain/ids.ts`;
    - порядок аргументів за Р11;
    - `toEntityId` у трансформері.
- [ ] `.claude/skills/backend-feature/SKILL.md` оновлюється тим самим комітом (вимога `AGENTS.md`).
- [ ] `documentation/backend/repositories.md`, `transformers.md`, `database.md` (обидві локалі): короткий розділ про
      бренди.

### T19 · Перевірка

- [ ] `db:generate` без міграції; `make test-pg`; `make test-redis` (лічильники).
- [ ] `pnpm docs:build && pnpm docs:verify` (T18 змінює `documentation/`).
- [ ] Golden path: вхід, відв'язування способу входу, WS-підключення.

### T20 · Закриття

- [ ] Крок «Закриття».

---

## feat-264 · Бренди id: решта доменів

### T21 · Старт

- [ ] Крок «Старт» для `feat-264`.

### T22 · Push — Р11

- [ ] `PushSubscriptionId`, `PushNotificationLogId`; `$type` на `push_subscriptions` і `push_notification_logs`
      (разом із FK `user_id`, якщо T12 його ще не брендував).
- [ ] `push-subscription-repository`:
    - `findByIdAndUserId` стає `findForUser(userId, id)`;
    - `update(userId, id, data)`;
    - `updateByEndpoint(userId, endpoint, data)`;
    - `deactivate(userId, id)`;
    - `touchLastUsed(userId, ids)`;
    - `delete(userId, id)`;
    - `getLogsBySubscriptionId(userId, subscriptionId, limit?)`.
- [ ] `push-notification-log-repository`: `countsBySubscription(userId, subscriptionId, since)` і
      `latestBySubscriptionIds(userId, subscriptionIds, limit)`.
- [ ] `push-subscription-statistics-service.ts:26`: `(userId, subscriptionId)`.
- [ ] Після задачі в цих файлах немає жодного методу, де `userId` стоїть другим.

### T23 · Notifications

- [ ] `NotificationId`; `$type` на `notifications`, `notification_preferences` (композитний PK, бренд лише на
      `user_id`); сигнатури репозиторіїв і сервісів.

### T24 · Support, AI, admin, audit

- [ ] `SupportArticleId` (`support_knowledge_base`), `SupportMessageId` (`support_chat_history`), `LlmSystemPromptId`,
      `LlmTextUsageId`, `AuditEventId`; `$type` і сигнатури.
- [ ] `decodeAuditCursor` повертає `{ occurredAt, id: AuditEventId }` через `parseAuditEventId`.
- [ ] `audit_events.target_id` (`varchar`) і `request_id` (`uuid`) не брендуються.
- [ ] Адмінські actor / target передаються об'єктом-параметром (Р11).

### T25 · Трансформери і перевірка

- [ ] Трансформери цих доменів використовують `toEntityId`.
- [ ] `controllers/shared/parse-id.ts` і `parse-id.spec.ts` видаляються: після T22–T24 жоден контролер не викликає
      `parseEntityId`, усі перейшли на конструктори з `app/domain/ids.ts` (Р4). `grep parseEntityId` порожній.
- [ ] `db:generate` без міграції, `make test-pg` (лічильники).
- [ ] Golden path: push-підписка, сповіщення, чат підтримки, журнал аудиту.

### T26 · Закриття

- [ ] Крок «Закриття».

---

## feat-265 · Секрети за станами

### T27 · Старт

- [ ] Крок «Старт» для `feat-265`.

### T28 · Одноразові токени

- [ ] Бренди секретів і їхні конструктори лежать в `app/domain/secrets.ts`. `one-time-token.ts`, `recovery-codes.ts`,
      `otp-verification-hash.ts`, `mfa-ticket.ts` імпортують їх звідти, тож `no-brand-cast` не потребує нових винятків
      (T16).
- [ ] `RawToken` / `TokenHash`:
    - `createToken(): RawToken`;
    - `hashToken(token: RawToken): TokenHash`;
    - `findUsableToken(repo, secret: RawToken)`;
    - `ITokenRepository.findByTokenHash(tokenHash: TokenHash)`;
    - `$type<TokenHash>()` на колонках `token_hash`.
- [ ] `oauth-service.ts:545,902`: `sessionBindingHash` має свій бренд `SessionBindingHash` і не змішується з
      `TokenHash`. `$type<SessionBindingHash>()` стоїть на `oauth_link_verifications.session_binding_hash`.
- [ ] Тести типів: сирий токен не приймається у `findByTokenHash`, а хеш — у `hashToken`.

### T29 · Коди відновлення і OTP

- [ ] Ланцюжок станів коду відновлення:
    - `normalizeRecoveryCode(raw: RawRecoveryCode): NormalizedRecoveryCode | null`;
    - `hashRecoveryCode(code: NormalizedRecoveryCode): RecoveryCodeHash`.
- [ ] `OtpCode` / `OtpHash` для `otp-verification-hash.ts` (`hashOtpVerificationCode`, `verifyOtpVerificationCode`).
- [ ] `$type` у схемі: `mfa_recovery_codes.code_hash` → `RecoveryCodeHash`, `sms_auth_challenges.code_hash` →
      `OtpHash`.
- [ ] Тести типів:
    - сирий код не приймається в `hashRecoveryCode`;
    - `OtpCode` не приймається на місці `expectedHash` у `verifyOtpVerificationCode`, а `OtpHash` — на місці `code`.

### T30 · Сесійний токен і `mfa_bind`

- [ ] `SessionToken`:
    - `users.session_token` отримує `$type<SessionToken>()` і `$defaultFn(newSessionToken)`;
    - `newSessionToken()` (nanoid + бренд) лежить в `app/domain/secrets.ts` без `#`-імпортів, а `schema.ts`
      імпортує його відносним шляхом (`../app/domain/secrets.js`). Це перший runtime-імпорт у `schema.ts`, тому
      одразу після нього запускається `db:generate`;
    - `checkSessionToken(userId, userToken: SessionToken)`;
    - `isSessionStored(sessionId: SessionId, userToken: SessionToken)`.
- [ ] Рядкові id: `SessionId`, `TicketId`, `CompletionId`, `ReservationId`, `AttemptId` у `mfa-ticket.ts`,
      `mfa-sign-in.ts`, `ws-session-revocation.ts`, `generate-ws-token-service.ts`.
- [ ] `MfaBindValue` / `MfaBinding`: `newBindValue(): MfaBindValue`, `mfaBinding(bindValue: MfaBindValue): MfaBinding`
      (`mfa-ticket.ts:75-81`).
    - `mfaBinding` читає `appConfig.key` (`#config`), тому лишається в `mfa-ticket.ts`. Бренд результату він
      отримує через чистий `asMfaBinding(hmac: string)` з `app/domain/secrets.ts`.
- [ ] Тест типів: `MfaBindValue` не порівнюється і не присвоюється з `MfaBinding` (і навпаки).
- [ ] У vendor-типі сесії токени лишаються `string` (Р13). Бренд з'являється на межі app.

### T31 · Перевірка

- [ ] `make test-redis` (лічильники): сесія з `userToken` читається як і раніше; MFA-тікет проходить reserve / reopen.
- [ ] `make test-pg` (лічильники): скидання пароля, підтвердження email, коди відновлення.
- [ ] `pnpm --filter backend db:generate` без нової міграції (T28–T30 змінюють `database/schema.ts`). Окремо
      перевіряється, що drizzle-kit завантажує схему разом із runtime-імпортом `newSessionToken`, тобто не падає на
      нерозв'язаному `#`-аліасі.
- [ ] Golden path: скидання пароля, вхід з TOTP, вхід кодом відновлення.

### T32 · Закриття

- [ ] Крок «Закриття».

---

## feat-266 · `NormalizedEmail`

### T33 · Старт

- [ ] Крок «Старт» для `feat-266`.

### T34 · Бренд і споживачі

- [ ] `normalizeEmail(raw: string): NormalizedEmail` переїжджає в `app/domain/email.ts`. `services/auth/auth-normalize.ts:11`
      реекспортує його або його виклики переходять на новий модуль, і `no-brand-cast` не потребує винятку (T16).
- [ ] `findByEmail`, створення користувача, пошук OAuth-зв'язку приймають `NormalizedEmail`. Решта 9 викликів
      `normalizeEmail` лишаються єдиним місцем створення бренду.
- [ ] `oauth-service.ts:240` (нормалізація домену) і `account-claim-service.ts:38`.
- [ ] `users.email` отримує `$type<NormalizedEmail>()`.
- [ ] Для `oauth_accounts.provider_email` спершу перевірити всі шляхи запису (`oauth-service.ts:496, 590, 644`). Бренд
      ставиться лише тоді, коли кожен із них нормалізує email.
- [ ] Те саме правило для трьох колонок `target_email` (`email_link_verifications`, `password_reset_tokens`,
      `oauth_link_verifications`): перевірити шляхи запису і поставити `$type<NormalizedEmail>()`. Якщо котрийсь шлях
      пише ненормалізоване значення, колонка лишається `string`, а причина записується в `progress.md`.

### T35 · Схеми shared

- [ ] `EmailInputSchema = type('string.email & string <= 255')` замінює три копії в `schemas/` (link-email-start,
      forgot-password, register-email).
- [ ] `EmailSchema` / `Email` видаляються з `brands/primitives.ts` і `brands/index.ts`.
- [ ] `shared/test`: `EmailInputSchema` приймає і відкидає ті самі значення, що й старі схеми.

### T36 · Перевірка і закриття

- [ ] `db:generate` без міграції, `make test-pg` (лічильники): реєстрація, вхід, OAuth-зв'язок з email у різному
      регістрі та з пробілами.
- [ ] Крок «Закриття».

---

## feat-267 · Одиниці часу

### T37 · Старт

- [ ] Крок «Старт» для `feat-267`.

### T38 · Типи й операції — Р7

- [ ] `shared/brand`: `Milliseconds`, `Seconds`, `UnixMs`; `nowUnixMs()`, `ms()`, `seconds()`, `addMs(at, delta)`,
      `diffMs(a, b)`, `toMs(s)`, `toSecondsFloor(ms)`, `toSecondsCeil(ms)`.
- [ ] Тести:
    - `toSecondsCeil(1)` = 1, `toSecondsCeil(1000)` = 1, `toSecondsCeil(1001)` = 2;
    - `toSecondsFloor(1999)` = 1;
    - `addMs` / `diffMs` зберігають бренд.
- [ ] `TimestampSchema` / `Timestamp` видаляються з `brands/primitives.ts` і реекспорту в `brands/index.ts`.
- [ ] Бекенд-специфічні обгортки часу (якщо знадобляться) лежать в `app/domain/time.ts` (T16).

### T39 · Redis TTL

- [ ] Типізовані обгортки: `EX` бере `Seconds`, `PX` / `PEXPIRE` бере `Milliseconds`. Вони застосовуються в
      `mfa-ticket.ts:329`, `passkey-login-challenges.ts:29,44`, `redis-lease.ts:123`, `llm-budget-service.ts:25`,
      `auth-throttle-service.ts:10`, `generate-ws-token-service.ts` (літерал `60`).
- [ ] Redis-тести перевіряють фактичний `TTL` / `PTTL` ключа після запису через обгортку (сесія, MFA-тікет, lease,
      бюджет LLM), і він не менший за точне значення.

### T40 · Конфіг, `Retry-After`, імена

- [ ] `config/session.ts:56`: `age` → `ageSeconds`, `anonAge` → `anonAgeSeconds`, значення типу `Seconds`.
- [ ] `config/throttle-policies.ts`: брендовані вікна.
- [ ] `Retry-After` у `rate-limit-store.ts:214`, `ws-message-budget.ts:108`, `support-service.ts:149`,
      `llm-budget-service.ts:65`, `sms-auth-challenge-metadata.ts:34` рахується через `toSecondsCeil`.
- [ ] Моменти часу (`issuedAt` у `request-session.ts:65`, крок TOTP) рахуються через `toSecondsFloor`.
- [ ] `now: number` у сигнатурах (`mfa-ticket.ts:347,401`, `sms-challenge.ts:187`, `scheduler-state.ts:30`, …) стає
      `nowMs: UnixMs`.

### T41 · Документація

- [ ] Сторінки config / scheduler (обидві локалі), де змінено назви налаштувань або одиниці.
- [ ] Якщо зміни в `redis-lease.ts` або `scheduler-state.ts` зачіпають контракт планувальника (`defineJob`,
      `JobContext`, `withJobLease`, межа lease Р13), оновити `documentation/en/backend/scheduler.md` (+ uk) і
      `.claude/skills/scheduled-job/SKILL.md` тим самим комітом (вимога `AGENTS.md`).

### T42 · Перевірка і закриття

- [ ] `make test-redis` (лічильники), golden path: вхід, ліміт запитів з `Retry-After`.
- [ ] `pnpm docs:build && pnpm docs:verify` (T41 змінює `documentation/`).
- [ ] Крок «Закриття».

---

## feat-268 · Shared і фронтенд (необов'язкова)

### T43 · Старт

- [ ] Крок «Старт» для `feat-268`. Перед стартом власник підтверджує, що фіча потрібна (Р8).

### T44 · Схеми відповідей

- [ ] `SessionPublicId` (`responses/account-sessions-controller.ts:17`), `IsoDateTime` (`string.date.iso` + бренд) для
      полів `*At`, `Cursor` для `nextCursor`, `EntityId` для id у відповідях.
- [ ] Опція: `QueryWireValue<T>` знімає бренд (`schemas/query/types.ts`). Тест типів показує, що фронтенд надсилає
      рядок, а контролер отримує бренд.

### T45 · Фронтенд

- [ ] `stores/user.ts:22` і `stores/push.ts:33` беруть типи з `shared/responses`. Індексна сигнатура в `User`
      прибирається.
- [ ] `ws-payload-guards.ts` звужує id до `EntityId`.
- [ ] Правило `no-brand-cast` додається в `packages/frontend/eslint.config.ts`.

### T46 · Тести фронтенду

- [ ] Тестові helper-и для всіх чотирьох брендів T44: `asEntityId()`, `asIsoDateTime()`, `asSessionPublicId()`,
      `asCursor()`.
- [ ] Типізовані фабрики (`ActiveSessions.spec.ts:30`, `AdminUsersView.spec.ts:18`, `AdminAuditLogView.spec.ts:23`) і
      ~108 літералів `id: '…'` переходять на них.

### T47 · Примітиви — Р9

- [ ] `PriceInCents` / `PriceInCentsSchema` видаляються з `brands/primitives.ts` і реекспорту в `brands/index.ts`.
- [ ] `shared/test`: тести на приймання й відхилення для `PositiveInt`, `NonNegativeInt`, `NonEmptyString`.

### T48 · Перевірка і закриття

- [ ] `make check`, `pnpm --filter frontend test:e2e`, golden path у браузері: сесії, сповіщення, адмінка.
- [ ] Крок «Закриття».
