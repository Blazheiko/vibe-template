# План: branded types і value objects

**Статус: погоджено власником** (2026-11-25): Р1–Р11. Р9 уточнено: `PositiveInt`, `NonNegativeInt`, `NonEmptyString`
лишаються. Р11: спершу власник, `(userId, id)`, на всіх шарах. Фічі: `feat-262`…`feat-268`.

## Задача

У `packages/shared/src/brands` є `EntityIdSchema` і шість примітивів (`Email`, `PositiveInt`, `NonNegativeInt`,
`PriceInCents`, `NonEmptyString`, `Timestamp`). Треба, щоб брендовані типи справді ловили помилки в коді, а не лише
лежали в теці.

## Що відомо (код)

**Бренди майже не використовуються.**

- `EntityIdSchema` стоїть лише у трьох схемах: `schemas/auth/unlink-sign-in-method.ts`, `schemas/ws/broadcast-events.ts`,
  `schemas/ws/ws-admin-user-online-upsert.ts`. Ще є тест типів `backend/src/app/shared-brands.spec.ts` і
  `shared/test/contracts.test.js`.
- Шість примітивів не імпортує ніхто.
- `TimestampSchema` (`number.integer >= 0`) суперечить формату на дроті: усі ~35 полів `*At` у відповідях передаються
  ISO-рядками.

**Ідентифікатори (backend).**

- Усі 21 таблиці мають PK `bigserial(..., { mode: 'bigint' })`, FK теж `bigint`. Бренду на колонках немає.
- У `app/` є 203 параметри `…Id: bigint` (з них 165 `userId`) і 186 параметрів `…Id: string`: `userId`, `sessionId`,
  `ticketId`, `enrollmentId`, `completionId`, `challengeId`, `reservationId`, `attemptId`.
- Приблизно 32 сигнатури мають два і більше id одного примітивного типу. **Порядок аргументів між шарами різний:**
    - `push-subscription-service` приймає `(userId, subscriptionId)`, а викликає
      `push-subscription-repository.findByIdAndUserId / deactivate / delete(id, userId)`
      (`repositories/notifications/push-subscription-repository.ts:44,65`).
    - `push-subscription-statistics-service.ts:26` приймає `(subscriptionId, userId)`, хоча викликач передає навпаки.
    - `notification-repository.ts:89` має `markRead(userId, id)`, а решта репозиторіїв — `(id, userId)`.
    - `passkey-service.ts:352` має `rename(userId, id, name)`, а викликає `webauthnCredentialRepository.rename(id, userId, …)`.
    - `totp-factor-repository.ts:42` має `consumeStep(id: bigint, userId: bigint, step: bigint)`: три `bigint` поспіль.
    - `mfa-sign-in.ts` має `reopenQuietly(ticketId, completionId, userId)`: три `string` поспіль. `mfa-ticket.ts` має `reserve(ticketId, …, reservationId, …, attemptId)`.

    Зараз усі виклики правильні. Ризик виникає за наступної зміни.

- Перетворень між `bigint` і `string` багато: 160 `String(id)` і 40 `BigInt(x)`. Частина `BigInt(x)` бере
  неперевірений рядок із сесії або WS (`permission-guard.ts:29,51`, `ws-coordinator.ts:74,88,138`,
  `auth-service.ts:1100,1176,1204,1230`, `mfa-sign-in.ts`).
- **Валідаторів id три, і вони розходяться:**
    - `parseEntityId` (`controllers/shared/parse-id.ts`): `/^\d{1,19}$/` плюс межа PG.
    - `ENTITY_ID_PATTERN` (`shared/src/patterns/index.ts:5`): `/^[1-9]\d*$/` **без верхньої межі**.
    - `isCanonicalEntityId` (`vendor/utils/helpers/entity-id.ts`).

    Ще чотири локальні regex у shared дублюють один одного: `NOTIFICATION_ID_PATTERN`, `IdSchema` у
    `responses/notifications-controller.ts:6`, `before?` у `query/support.ts:14`, `REVISION_PATTERN`.

- **Два баги того ж класу, що feat-161** (значення за межами `bigint` дає 500):
    - `controllers/http/auth/sign-in-methods-controller.ts:29` робить `BigInt(payload.id)` над `EntityIdSchema`, де немає
      верхньої межі.
    - `controllers/http/ai/usage/llm-usage-controller.ts:11` робить `BigInt(userId.trim())` у try/catch, тож приймає
      `0x10` і `-5`.

**Секрети (усе `string`).**

- Сирий токен і його хеш мають той самий тип: `hashToken(token): string`, `findUsableToken(repo, secret)`,
  `ITokenRepository.findByTokenHash(tokenHash: string)`. Сирий токен, переданий у `findByTokenHash`, компілюється.
- Код відновлення проходить три стани в одному `string`: сирий, нормалізований (`normalizeRecoveryCode`) і хеш
  (`hashRecoveryCode`). Те саме з OTP (`verifyOtpVerificationCode(code, expectedHash)`).
- `checkSessionToken(userId: string, userToken: string)` і `isSessionStored(sessionId: string, userToken: string)`
  приймають по два рядки. Ключ Redis `session:${userToken}:${sessionId}` залежить від порядку аргументів.

**Email.** `normalizeEmail` (`auth-normalize.ts:11`, `trim().toLowerCase()`) викликається в 9 місцях. Репозиторій ще раз
робить `LOWER()`, але не `trim` (`user-repository.ts:193,297`). `findByEmail(email: string)` покладається на те, що
нормалізує викликач. Параметрів `email: string` 29. Схеми запитів тричі повторюють `'string.email & string <= 255'`
замість `EmailSchema`.

**Час.** Суфікси `*Ms`/`*Seconds` переважно є (242 і 62), але:

- `now: number` (мс) без суфікса стоїть приблизно у 21 сигнатурі.
- `config/session.ts:56` має `age` і `anonAge` у секундах без суфікса.
- У Redis змішано `EX` (секунди: `mfa-ticket.ts:329`, `passkey-login-challenges.ts`) і `PX`/`PEXPIRE` (мс:
  `redis-lease.ts:123`, `llm-budget-service.ts:25`).
- Є 93 ручні `* 1000` / `/ 1000`.

**Shared і frontend.**

- Тіла запитів у контрактах типізовані через `Schema.inferIn`. arktype знімає бренд на вході
  (`@ark/schema` `_distill`), тому фронтенд надсилає звичайні рядки, а контролер отримує бренд через `Schema.infer`.
  Це вже працює для `UnlinkSignInMethodInputSchema`.
- `QueryInputOf` бере значення з `infer`, тож брендоване поле query **змусило б фронтенд створювати бренд**.
- WS-payload (`BroadcastPayload = inferIn`) теж знімає бренд.
- Відповіді (`typeof X.infer`) доходять до фронтенду з брендом. Але `stores/user.ts:22` і `stores/push.ts:33`
  описують типи вручну, а тести фронтенду мають 108 літералів `id: '…'` у 32 файлах і типізовані фабрики
  (`ActiveSessions.spec.ts:30`, `AdminUsersView.spec.ts:18`, `AdminAuditLogView.spec.ts:23`).
- `frontend/src/utils/ws-payload-guards.ts:25` має `isEntityId`, який звужує до `string`, а не до `EntityId`.
- `contracts/core.ts` описує `PathParams` як `Record<name, string>`, тому path-параметри завжди нетипізовані.

**Гроші** у шаблоні відсутні, `PriceInCents` нікому не потрібен.

## Рішення (пропозиція)

- **Р1. Бренд, а не клас.** Value object у цьому шаблоні — це брендований примітив плюс модуль зі «smart constructor»
  (`parse…` → `T | null`, `as…` лише для довірених джерел). Класи не потрібні: значення мають серіалізуватися в JSON,
  ходити через Redis і Drizzle без перетворень, а `bigint` не можна обгорнути без втрат. Поведінку несуть функції
  модуля (`normalizeEmail`, `hashToken`, `seconds(ms)`).
- **Р2. Один тип `Brand`.** У `shared/src/brands/brand.ts` визначається `Brand<T, Id>` тієї самої форми, яку дає arktype
  `.brand()` (`T & { readonly ' brand': [T, Id] }`, `@ark/util/out/generics.d.ts:41`). Тоді вивід схеми і бренд,
  створений вручну, сумісні між собою. Тест типів доводить сумісність. Якщо arktype змінить форму, тест упаде.
- **Р3. Бренди id для кожної сутності, тип `bigint`, тільки бекенд.** Для `UserId`, `SessionRowId`,
  `PushSubscriptionId`, `NotificationId`, `PasskeyId`, `TotpFactorId`, `OAuthAccountId`, `SupportArticleId` тощо
  вводиться `Brand<bigint, 'UserId'>`. Головний важіль — Drizzle `.$type<UserId>()` на PK і на FK у `database/schema.ts`.
  Рядки з репозиторіїв стають брендованими автоматично, і змінювати треба лише сигнатури. Бренди лежать у
  `backend/src/app/domain/ids.ts`, бо фронтенду `bigint`-id не потрібні, а репозиторії, сервіси й контролери можуть
  імпортувати цей модуль без порушення `layering.spec.ts`.
- **Р4. Один парсер id.** `parseId<B>(raw): B | null` замінює `parseEntityId`, `isCanonicalEntityId` і всі `BigInt(x)`
  над зовнішніми даними. `ENTITY_ID_PATTERN` отримує верхню межу `\d{0,18}` і перевірку значення
  ≤ 9223372036854775807 у схемі, а локальні дублікати regex прибираються. На дроті бренд лишається один —
  `EntityId` (рядок). Перетворення `EntityId ↔ UserId` роблять лише `parseId` і `toEntityId` (у трансформерах).
- **Р5. Секрети за станами.** Вводяться `RawToken` / `TokenHash`, `RawRecoveryCode` / `NormalizedRecoveryCode` /
  `RecoveryCodeHash`, `OtpCode` / `OtpHash`, `SessionToken` (поле `users.session_token`, `userToken` у сесії) і
  рядкові id сесії та MFA (`SessionId`, `TicketId`, `CompletionId`, `ReservationId`, `AttemptId`). Хешувальні
  функції приймають лише сирий стан і повертають лише хеш, а репозиторії шукають лише за хешем.
- **Р6. `NormalizedEmail`.** Його створює тільки `normalizeEmail`. `findByEmail`, `createUser` і пошук OAuth-зв'язку
  приймають `NormalizedEmail`, тому забути нормалізацію неможливо. `LOWER()` у SQL лишається як страховка для
  старих даних. У shared з'являється `EmailInputSchema = 'string.email & string <= 255'`, що замінює три копії.
  `EmailSchema` у brands перейменовується або прибирається (Р9).
- **Р7. Одиниці часу.** Вводяться `Milliseconds`, `Seconds`, `UnixMs` (`Date.now()`) з конструкторами `ms()`,
  `seconds()`, `toSeconds()`, `toMs()`. TTL у Redis передаються через обгортки `setWithTtl(key, value, ttl: Seconds)`
  і `pexpire(key, ttl: Milliseconds)` (або типізовані сигнатури наявних helper-ів). Конфіг (`config/session.ts`,
  `throttle-policies.ts`) експортує брендовані значення. Імена `now`/`age` дістають суфікси.
- **Р8. Shared і фронтенд — окрема, необов'язкова фіча.** Бренди на id у відповідях коштують ~108 тестових літералів і
  типізованих фабрик. Пропонується спершу дати фронтенду лише `SessionPublicId`, `IsoDateTime`, `Cursor` і `EntityId`
  у відповідях, а в тестах — helper `asEntityId()`. Брендовані поля query не вводяться (див. `QueryInputOf`).
  Типізація path-параметрів через контракт виноситься в окрему пізнішу ідею.
- **Р9. Чистка примітивів.** Без зворотної сумісності (шаблон):
    - `PriceInCents` видаляється.
    - `Timestamp` перейменовується в `UnixMs` і переїжджає до Р7.
    - `PositiveInt`, `NonNegativeInt` і `NonEmptyString` лишаються (рішення власника) як готові будівельні блоки
      шаблону; тест на приймання/відхилення для кожного додається в `shared/test`.
- **Р10. ADR 0007 «Branded types».** ADR фіксує Р1–Р4, правило «зовнішній рядок стає брендом лише через схему або
  `parse…`» і заборону `as UserId` поза конструкторами. Заборону перевіряє ESLint `no-restricted-syntax` на
  `TSAsExpression` до брендових типів, з винятком для модулів-конструкторів і тестів.
- **Р11. Порядок id в аргументах: спершу власник, `(userId, id)`, на всіх шарах** (погоджено 2026-11-25).
    - Сервіси вже так написані (`getSubscription(userId, subscriptionId)`, `unlink(userId, …)`). Міняються 7 методів
      репозиторіїв з порядком `(id, userId)`: `push-subscription-repository` `findByIdAndUserId` / `deactivate` /
      `delete`, `webauthn-credential-repository` `rename` / `deleteOne`, `oauth-account-repository`
      `deleteByIdForUser`, `totp-factor-repository` `consumeStep`. Сюди ж `push-subscription-statistics-service`
      `(subscriptionId, userId)`. `notification-repository.markRead(userId, id)` уже відповідає правилу.
    - Назви методів збігаються з порядком: `findByIdAndUserId` → `findForUser(userId, id)`,
      `deleteByIdForUser` → `deleteForUser(userId, id)`.
    - Після Р3 переставлені id різних сутностей (`UserId` ↔ `PushSubscriptionId`) не компілюються, тож правило
      відповідає за читабельність, а безпеку дають бренди.
    - Два id одного бренду (адміністратор і цільовий користувач) передаються лише об'єктом-параметром, як у
      `mfaResetService.reset({ actor, targetUserId, … })` і `roleAssignmentService.assign({ actor, targetUserId, … })`.
    - Правило записується в ADR 0007, tutorial `adding-a-feature` (обидві локалі) і скіл `backend-feature`.

## Кроки

### feat-262: один валідатор id (баг-фікс, без брендів)

- Додати межу PG в `ENTITY_ID_PATTERN` / `EntityIdSchema`. Прибрати локальні дублікати regex.
- `sign-in-methods-controller.ts:29` і `llm-usage-controller.ts:11` перевести на `parseEntityId`.
- Прибрати `isCanonicalEntityId` (замінити на спільний pattern).
- Тести: `9223372036854775808`, `0x10`, `-5`, `0`, `007` дають 400/404, а не 500 (PG).
- Документація: `documentation/backend/` (обидві локалі), де описано формат id.

### feat-263: бренди id — інфраструктура + users/auth (залежить від feat-262)

- ADR 0007 (Р10), `shared/brands/brand.ts` (Р2), тест сумісності з arktype.
- `app/domain/ids.ts`: бренди, `parseId`, `toEntityId`.
- `database/schema.ts`: `.$type<…>()` на всіх PK/FK.
- Сигнатури репозиторіїв і сервісів users, sessions, auth, oauth, mfa, passkeys, а також `permission-guard`,
  `ws-coordinator`, `SessionData.userId`.
- Порядок аргументів за Р11 для доменів users/auth (`webauthn-credential`, `oauth-account`, `totp-factor`).
- ESLint-правило проти `as Brand`.
- Оновити `documentation/en/backend/adding-a-feature.md` (+ uk) і скіл `backend-feature`: репозиторій і трансформер
  працюють із брендованими id. AGENTS.md цього вимагає.

### feat-264: бренди id — notifications, push, support, AI, admin, audit (залежить від feat-263)

- Решта доменів, порядок аргументів за Р11: `push-subscription-repository`, `push-subscription-statistics-service`.

### feat-265: секрети за станами (залежить від feat-263)

- Р5: `one-time-token.ts`, `token-repository.ts`, `recovery-codes.ts`, `otp-verification-hash.ts`,
  `session-token-check.ts`, `ws-session-revocation.ts`, `generate-ws-token-service.ts`, `mfa-ticket.ts`,
  `mfa-sign-in.ts`, `oauth-service.ts` (`sessionBindingHash`).
- Тести типів (`@ts-expect-error`): сирий токен не приймається у `findByTokenHash`, хеш не приймається в `hashToken`.

### feat-266: `NormalizedEmail` (залежить від feat-263)

- Р6: `auth-normalize.ts`, 9 викликів, `user-repository`, `oauth-service.ts:240` (домен), `account-claim-service`.
  Схема `EmailInputSchema` у shared.

### feat-267: одиниці часу (без залежностей; можна паралельно з feat-263)

- Р7: брендовані `Milliseconds`/`Seconds`/`UnixMs`, обгортки TTL у Redis, `config/session.ts`, `throttle-policies.ts`,
  `mfa-ticket.ts`, `sms-challenge.ts`, `redis-lease.ts`, `llm-budget-service.ts`, `generate-ws-token-service.ts`
  (літерал `60`).
- Документація scheduler / config за потреби.

### feat-268: shared і фронтенд (необов'язкова, залежить від feat-263, рішення Р8)

- `SessionPublicId`, `IsoDateTime` (`string.date.iso` + бренд), `Cursor`, `EntityId` у схемах відповідей.
- `ws-payload-guards.ts` звужує до брендів. `stores/user.ts` і `stores/push.ts` беруть типи з `shared/responses`.
- Helper `asEntityId()` для тестів, оновлення фабрик.
- Р9: чистка `brands/primitives.ts`.

## Перевірка (Definition of Done)

- `make check` (зокрема `typecheck` для `__tests__` фронтенду) для кожної фічі.
- `make test-pg` з лічильниками executed/skipped для feat-262–feat-266: вони зачіпають репозиторії й межі `bigint`.
- Тести типів з `@ts-expect-error` на кожен новий бренд (за взірцем `shared-brands.spec.ts`).
- `pnpm docs:build && pnpm docs:verify`, коли змінено документацію.
- Рантайм-поведінка не змінюється, крім баг-фіксу feat-262. Бренди існують лише на рівні типів.

## Ризики

- **Обсяг диффу.** feat-263/264 зачіпають сотні сигнатур. Ризик знижує те, що `$type` у схемі дає бренд «згори», а
  помилки компілятора самі показують місця, які треба змінити. Фіча ділиться за доменами, щоб PR лишалися
  переглядними.
- **Drizzle rc.** Треба перевірити, що `.$type<Brand<bigint,…>>()` у `1.0.0-rc.5` проходить через RQB v2
  (`defineRelations`) і `inArray`/`eq`. Це перший крок feat-263. Якщо не проходить — бренд застосовується на межі
  репозиторію.
- **arktype змінить форму `Brand`.** Від цього захищає тест сумісності (Р2).
- **Втеча через `as`.** Від неї захищає ESLint-правило (Р10).

## Поза планом

- `TokenCount` / `BudgetCallKind` у LLM-бюджеті: користь мала, можна додати у feat-264, якщо дешево.
- Брендовані ключі Redis і S3 (`RedisKey`, `S3ObjectKey`): ключі збираються інлайн, але помилок поки не видно.
- `IpAddress`, `UserAgent`, `Locale`: це рядки без інваріанту, і бренд тут нічого не ловить.
- Типізовані path-параметри в `contracts/core.ts`: окрема ідея, бо зачіпає ADR 0005.
