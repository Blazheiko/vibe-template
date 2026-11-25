# План: branded types і value objects

**Статус: погоджено власником** (2026-11-25): Р1–Р13 (редакція 5). Р9 уточнено: `PositiveInt`, `NonNegativeInt`, `NonEmptyString`
лишаються. Р11: спершу власник, `(userId, id)`, на всіх шарах. Фічі: `feat-262`…`feat-268`. Покроковий task list:
[`branded-types-tasks.md`](./branded-types-tasks.md).

**Редакція 2** (2026-11-25, за рев'ю плану):

- `$type` у `schema.ts` додається разом із доменом, а не на всі таблиці у feat-263 (Р3).
- Бренди id для схеми лежать у `database/ids.ts` і імпортуються тільки як тип, бо drizzle-kit не знає `#`-аліасів.
  `db:generate` без диффу входить у DoD.
- Новий subpath `shared/brand` без ArkType (`Brand`, `isValidEntityId`, конструктори часу) з'являється вже у feat-262
  (Р2, Р12). Через це feat-267 залежить від feat-262.
- feat-262 уточнено: `parseEntityId` більше не приймає `'0'` і `'007'`, llm-usage повертає явний 400, межа `bigint`
  перевіряється функцією, а не regex. `REVISION_PATTERN` не є дублікатом id.
- Враховано PK не з `bigserial` (`SmsChallengeId`), спільний бренд `OneTimeTokenRowId`, `requireUserId`.
- Р11 доповнено п'ятьма методами push і правилом для ключа, який не є id (`updateByEndpoint`).
- feat-265 доповнено `mfa_bind` і дефолтом `users.session_token`.
- `EmailSchema` прибирається у feat-266, `Timestamp` у feat-267.
- Додано арифметику часу, правило округлення TTL, точніше ESLint-правило.
- У DoD додано `make test-redis`.

**Редакція 3** (2026-11-25, друге рев'ю плану):

- Виправлено опис unlink: завеликий `linkId` дає 404, а не 500. Це прогалина валідації на вході.
- feat-262 отримала таблицю контракту для кожного входу з id, тест AI usage без фільтра, пробіли в тестах і курсор
  аудиту (`decodeAuditCursor`) як четвертий дублікат валідатора.
- feat-263 починається з наскрізного сценарію unlink (`UserId` + `OAuthAccountId`) з явними критеріями успіху.
- `parseId<B>` замінено конструкторами для кожного бренду (`parseUserId`, `parseOAuthAccountId`, …), бо generic
  дозволяв викликачеві самому вибрати бренд (Р4).
- Сесія з Redis отримує `UserId` лише після перевірки під час відновлення, а в JSON id лишається рядком (Р13).
- Ланцюжок recovery code: хеш приймає `NormalizedRecoveryCode` (Р5).
- Округлення: тривалість округлюється вгору, момент часу вниз. Тест перевіряє фактичний `TTL`/`PTTL` у Redis (Р7).
- У Р8 записано межу спільного `EntityId` на фронтенді.

**Редакція 4** (2026-11-25, третє рев'ю плану):

- Небрендована `EntityIdStringSchema` для query-, request- і response-схем. Інакше заміна локальних regex на голий
  `ENTITY_ID_PATTERN` пропустила б `2^63` у `support` `before` і дала б 500 (Р4).
- Відмову схеми в таблиці feat-262 виправлено на 422 (`ValidationError`), додано `?before` і `upTo` notifications.
  llm-usage: без `.trim()`, як у `admin-user-controller`.
- Р13 охоплює обидва записи з Redis у `ws-session-auth.ts`: WS-токен `auth:ws:*` і `SessionInfo`.

**Редакція 5** (2026-11-25, четверте рев'ю плану):

- Таблиця контракту feat-262 має дві колонки, «зараз» і «після», і правило: `0` не є допустимим курсором чи `before`
  ні на одному маршруті.
- Р13 спрощено: vendor-типи `SessionData` / `SessionInfo` не змінюються (`userId: string`), а бренд з'являється лише на
  межі app через `parseUserId`. Це закриває і HTTP-шлях (`redis-session-storage.ts`), і запис сесії.
- Р10: замість `no-restricted-syntax` за іменами — локальне type-aware правило ESLint, яке дивиться на кінцевий тип
  приведення (аліаси й перейменовані імпорти не обходять його).
- feat-262 названо «спільний валідатор id»; у її DoD явно додано `check-bundle-graph` і frontend-тест `isValidEntityId`.
- Р10: межа `no-brand-cast` — тип приведення і члени union / intersection, без рекурсії в поля об'єктів.
- Покроковий task list: [`branded-types-tasks.md`](./branded-types-tasks.md).

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
- `brands/ids.ts` і `brands/primitives.ts` імпортують `@arktype/type`, а `frontend/scripts/check-bundle-graph.mjs:18-26`
  забороняє ArkType у бандлі фронтенду (ADR 0005). Тому фронтенд може брати з `shared/brands` тільки `import type`.

**Ідентифікатори (backend).**

- PK у більшості таблиць `bigserial(..., { mode: 'bigint' })`, FK `bigint`. Винятки:
    - `sms_auth_challenges.id` має тип `varchar(24)` (nanoid);
    - у `user_preferences` PK — це `userId`;
    - у `notification_preferences` PK композитний (`userId`, `category`, `channel`).

    Бренду на колонках немає.

- `drizzle.config.ts:5`: drizzle-kit завантажує `schema.ts` сам, без `#`-аліасів. У `schema.ts` зараз немає жодного
  `#app/*`-імпорту.
- У `app/` є 203 параметри `…Id: bigint` (з них 165 `userId`) і 186 параметрів `…Id: string`: `userId`, `sessionId`,
  `ticketId`, `enrollmentId`, `completionId`, `challengeId`, `reservationId`, `attemptId`.
- Приблизно 32 сигнатури мають два і більше id одного примітивного типу. **Порядок аргументів між шарами різний:**
    - `push-subscription-service` приймає `(userId, subscriptionId)`, а викликає
      `push-subscription-repository.findByIdAndUserId / update / deactivate / delete(id, userId)`
      (`repositories/notifications/push-subscription-repository.ts:44-74`).
    - `push-subscription-statistics-service.ts:26` приймає `(subscriptionId, userId)`, хоча викликач передає навпаки.
    - `notification-repository.ts:89` має `markRead(userId, id)`, а решта репозиторіїв — `(id, userId)`.
    - `passkey-service.ts:352` має `rename(userId, id, name)`, а викликає `webauthnCredentialRepository.rename(id, userId, …)`.
    - `totp-factor-repository.ts:42` має `consumeStep(id: bigint, userId: bigint, step: bigint)`: три `bigint` поспіль.
    - `mfa-sign-in.ts` має `reopenQuietly(ticketId, completionId, userId)`: три `string` поспіль. `mfa-ticket.ts` має `reserve(ticketId, …, reservationId, …, attemptId)`.

    Зараз усі виклики правильні. Ризик виникає за наступної зміни.

- `repositories/auth/token-repository.ts:30,52` узагальнює чотири таблиці одноразових токенів одним
  `ITokenRepository<TRow, TInsert>`. Їхні id не виходять за межі `one-time-token.ts`.
- Перетворень між `bigint` і `string` багато: 160 `String(id)` і 40 `BigInt(x)`. Частина `BigInt(x)` бере
  неперевірений рядок із сесії або WS:
    - `controllers/shared/require-user-id.ts:14`
    - `permission-guard.ts:29,51`
    - `ws-coordinator.ts:74,88,138`
    - `auth-service.ts:1100,1176,1204,1230`
    - `mfa-sign-in.ts`
- **Валідаторів id чотири, і вони розходяться:**
    - `parseEntityId` (`controllers/shared/parse-id.ts`): `/^\d{1,19}$/` плюс межа PG. Він **приймає `'0'` і `'007'`**,
      і `parse-id.spec.ts:10` вважає `['0', 0n]` валідним.
    - `ENTITY_ID_PATTERN` (`shared/src/patterns/index.ts:5`): `/^[1-9]\d*$/` **без верхньої межі**. Його використовують
      `EntityIdSchema` (паритет перевіряє `shared/test/contracts.test.js:169-174`), query-схеми й
      `frontend/src/utils/ws-payload-guards.ts:25`.
    - `isCanonicalEntityId` (`vendor/utils/helpers/entity-id.ts`).
    - `decodeAuditCursor` (`services/admin/audit-events-query-service.ts:55-64`): власні `ID_TEXT` і
      `MAX_POSTGRES_BIGINT` для id, декодованого з курсора.

    Локальні regex, що дублюють id: `NOTIFICATION_ID_PATTERN` (`schemas/notifications/requests.ts:5`), `IdSchema` у
    `responses/notifications-controller.ts:6`, `before?` у `query/support.ts:14`. `ProfileRevisionSchema` і
    `REVISION_PATTERN` (`ws-payload-guards.ts:90`) **не є дублікатами**: ревізія спеціально дозволяє `'0'`, коли
    `user_preferences` ще не створено.

- **Дві прогалини на межі `bigint`:**
    - `controllers/http/auth/sign-in-methods-controller.ts:29` робить `BigInt(payload.id)` над `EntityIdSchema`, де немає
      верхньої межі. `BigInt` не падає на великих числах, а `sign-in-methods-service.ts:144` порівнює `linkId` з уже
      прочитаними зв'язками в пам'яті, тому `9223372036854775808` дає 404, а не 500. Помилки немає, але це прогалина
      валідації на вході: невалідний id доходить до сервісу.
    - `controllers/http/ai/usage/llm-usage-controller.ts:8-15` робить `BigInt(userId.trim())` у
      `catch { /* ignore invalid */ }`. Помилка тиха: невалідний `userId` (`abc`, а також `0x10` і `-5`, які `BigInt`
      приймає) знімає фільтр, і відповідь 200 повертає всі рядки.

**Секрети (усе `string`).**

- Сирий токен і його хеш мають той самий тип: `hashToken(token): string`, `findUsableToken(repo, secret)`,
  `ITokenRepository.findByTokenHash(tokenHash: string)`. Сирий токен, переданий у `findByTokenHash`, компілюється.
- Код відновлення проходить три стани в одному `string`: сирий, нормалізований (`normalizeRecoveryCode`) і хеш
  (`hashRecoveryCode(normalized)`, `recovery-codes.ts:47`, тобто хеш бере вже нормалізований код). Те саме з OTP (`verifyOtpVerificationCode(code, expectedHash)`).
- `mfa-ticket.ts:75-81` має `mfaBinding(bindValue)`, тобто HMAC сирого значення cookie `mfa_bind`. Сире значення і
  прив'язка обидва мають тип `string`.
- `checkSessionToken(userId: string, userToken: string)` і `isSessionStored(sessionId: string, userToken: string)`
  приймають по два рядки. Ключ Redis `session:${userToken}:${sessionId}` залежить від порядку аргументів.
- `users.session_token` (`schema.ts:89`) має `.$defaultFn(() => nanoid())`.
- Сесія читається з Redis як `JSON.parse(sessionData) as SessionInfo` (`websocket/ws-session-auth.ts:63`), і
  `SessionData.userId` має тип `string`. Брендований `userId` у цьому типі з'явився б через `as`, без перевірки.
  HTTP-шлях так само: `vendor/utils/session/redis-session-storage.ts` має сім `JSON.parse(...) as SessionInfo` /
  `as SessionData` (`:143, 176, 235, 262, 296, 308, 328, 378`).

**Email.**

- `normalizeEmail` (`auth-normalize.ts:11`, `trim().toLowerCase()`) викликається в 9 місцях.
- Репозиторій ще раз робить `LOWER()`, але не `trim` (`user-repository.ts:193,297`). `findByEmail(email: string)`
  покладається на те, що нормалізує викликач.
- `oauth-service.ts:496` нормалізує email провайдера перед записом `providerEmail`. Інші шляхи запису ще треба перевірити.
- Параметрів `email: string` 29. Схеми запитів тричі повторюють `'string.email & string <= 255'` замість `EmailSchema`.

**Час.** Суфікси `*Ms`/`*Seconds` переважно є (242 і 62), але:

- `now: number` (мс) без суфікса стоїть приблизно у 21 сигнатурі.
- `config/session.ts:56` має `age` і `anonAge` у секундах без суфікса.
- У Redis змішано `EX` (секунди: `mfa-ticket.ts:329`, `passkey-login-challenges.ts`) і `PX`/`PEXPIRE` (мс:
  `redis-lease.ts:123`, `llm-budget-service.ts:25`).
- Є 93 ручні `* 1000` / `/ 1000`.
- Округлення вже різне: момент часу `issuedAt` округлюється вниз (`vendor/utils/session/request-session.ts:65`,
  `Math.floor`), а тривалості вгору (`rate-limit-store.ts:214`, `llm-budget-service.ts:65`,
  `sms-auth-challenge-metadata.ts:34`, `Math.ceil`).

**Shared і frontend.**

- Тіла запитів у контрактах типізовані через `Schema.inferIn`. arktype знімає бренд на вході
  (`@ark/schema` `_distill`), тому фронтенд надсилає звичайні рядки, а контролер отримує бренд через `Schema.infer`.
  Це вже працює для `UnlinkSignInMethodInputSchema`.
- `QueryInputOf` (`schemas/query/types.ts:10-16`) бере значення з `infer`. Через це брендоване поле query змусило б
  фронтенд створювати бренд, якщо `QueryWireValue` не знімає бренд (див. feat-268).
- WS-payload (`BroadcastPayload = inferIn`) теж знімає бренд.
- Відповіді (`typeof X.infer`) доходять до фронтенду з брендом. Але `stores/user.ts:22` і `stores/push.ts:33`
  описують типи вручну, а тести фронтенду мають 108 літералів `id: '…'` у 32 файлах і типізовані фабрики
  (`ActiveSessions.spec.ts:30`, `AdminUsersView.spec.ts:18`, `AdminAuditLogView.spec.ts:23`).
- `frontend/src/utils/ws-payload-guards.ts:25` має `isEntityId`, який звужує до `string`, а не до `EntityId`.
- `contracts/core.ts` описує `PathParams` як `Record<name, string>`, тому path-параметри завжди нетипізовані.
- `packages/frontend/eslint.config.ts` — окремий конфіг ESLint, і він не успадковує правил кореня.

**Гроші** у шаблоні відсутні, `PriceInCents` нікому не потрібен.

## Рішення

- **Р1. Бренд, а не клас.** Value object у цьому шаблоні — це брендований примітив плюс модуль зі «smart constructor»
  (`parse…` → `T | null`, `as…` лише для довірених джерел). Класи не потрібні: значення мають серіалізуватися в JSON,
  ходити через Redis і Drizzle без перетворень, а `bigint` не можна обгорнути без втрат. Поведінку несуть функції
  модуля (`normalizeEmail`, `hashToken`, `addMs`).
- **Р2. Один тип `Brand`, без ArkType.**
    - `Brand<T, Id>` визначається в новому subpath `shared/brand` (`packages/shared/src/brand/`) **без жодного імпорту
      ArkType**. Форма та сама, яку дає arktype `.brand()`: `T & { readonly ' brand': [T, Id] }`
      (`@ark/util/out/generics.d.ts:41`).
    - Тест типів перевіряє **двосторонню рівність** `AssertEqual<Brand<string, 'EntityId'>, typeof EntityIdSchema.infer>`
      за взірцем `schemas/query/types.ts:33-35`. Якщо arktype змінить форму, тест упаде.
    - У `shared/brand` лежать тільки helper-и без залежностей (`isValidEntityId`, конструктори часу з Р7), тому їх можна
      імпортувати на фронтенді як значення. `shared/brands` лишається для ArkType-схем, а фронтенд бере звідти лише
      `import type`. `check-bundle-graph` це перевіряє.
- **Р3. Бренди id для кожної сутності, тип `bigint`, тільки бекенд, разом із доменом.**
    - Бренди: `UserId`, `PushSubscriptionId`, `NotificationId`, `PasskeyId`, `TotpFactorId`, `OAuthAccountId`,
      `SupportArticleId` тощо, через `Brand<bigint, 'UserId'>`.
    - Виняток: `SmsChallengeId = Brand<string, 'SmsChallengeId'>`.
    - Чотири таблиці одноразових токенів мають один спільний бренд `OneTimeTokenRowId`. Їхні id не виходять за межі
      `one-time-token.ts`, і `ITokenRepository` не треба параметризувати ще й типом id.
    - Головний важіль — Drizzle `.$type<UserId>()` на PK і FK. Рядки з репозиторіїв стають брендованими автоматично.
    - **`$type` додається в тій самій фічі, що й сигнатури цього домену.** Брендована колонка не приймає `bigint` в
      `eq(column, value)` і `.values({...})`, тому брендувати таблицю раніше за її репозиторій означає зламати
      компіляцію. Зворотний напрям безпечний: `UserId` передається в ще не мігрований параметр `bigint`.
    - Бренди лежать у `backend/src/database/ids.ts`, суто як оголошення типів на `shared/brand`. `schema.ts` імпортує
      їх відносним `import type`, бо drizzle-kit не знає `#`-аліасів. `app/domain/ids.ts` реекспортує їх і додає
      конструктори (Р4), тож залежності `database → app` немає.
    - Фронтенду `bigint`-id не потрібні. Модуль доступний репозиторіям, сервісам і контролерам без порушення
      `layering.spec.ts`.
- **Р4. Один парсер id.**
    - `isValidEntityId(value: string): boolean` у `shared/brand`: `ENTITY_ID_PATTERN` (`/^[1-9]\d{0,18}$/`) і межа
      `value.length < 19 || value <= '9223372036854775807'`. Межу перевіряє порівняння рядків, regex її не дає. Функція
      працює в браузері без ArkType.
    - Дві схеми в `shared/brands/ids.ts`:

        ```ts
        export const EntityIdStringSchema = type(ENTITY_ID_PATTERN).narrow(isValidEntityId)
        export const EntityIdSchema = EntityIdStringSchema.brand('EntityId')
        ```

        Query-схеми використовують `EntityIdStringSchema`, бо `QueryInputOf` бере значення з `infer`, і бренд у query
        зламав би фронтенд до feat-268. Request- і response-схеми теж використовують її там, де бренд не потрібен. Голий
        `ENTITY_ID_PATTERN` у схемах більше не стоїть: він не має верхньої межі.

    - `parseEntityId` і `ws-payload-guards` викликають `isValidEntityId`. Паритетний тест у `contracts.test.js`
      порівнює `isValidEntityId` з обома схемами.
    - `'0'` і `'007'` не є id.
    - `decodeAuditCursor` перевіряє id, декодований з курсора, тією ж функцією. Формат самого курсора лишається
      окремим.
    - У feat-263 на кожен бренд є свій конструктор: `parseUserId(raw): UserId | null`, `parseOAuthAccountId`,
      `parsePushSubscriptionId` тощо. Публічного generic `parseId<B>` немає, бо він дозволяв би викликачеві самому
      вибрати бренд, тобто це був би той самий cast. Спільна реалізація (`isValidEntityId` + `BigInt`) лишається
      приватною всередині `app/domain/ids.ts`.
    - Конструктори замінюють `parseEntityId`, `isCanonicalEntityId` і всі `BigInt(x)` над зовнішніми даними, зокрема
      `requireUserId`.
    - На дроті бренд лишається один — `EntityId` (рядок). Перетворення `EntityId ↔ UserId` роблять лише конструктори і
      `toEntityId` (у трансформерах).
- **Р5. Секрети за станами.**
    - Вводяться `RawToken` / `TokenHash`, `OtpCode` / `OtpHash` і `MfaBindValue` / `MfaBinding` (cookie `mfa_bind` і
      її HMAC).
    - Код відновлення має три стани:
      `RawRecoveryCode → normalizeRecoveryCode → NormalizedRecoveryCode | null → hashRecoveryCode → RecoveryCodeHash`.
    - `SessionToken` — це поле `users.session_token` і `userToken` у сесії. Дефолт колонки викликає конструктор
      `newSessionToken()` замість голого `nanoid()`.
      `newSessionToken` лежить у модулі без `#`-імпортів, і `schema.ts` імпортує його відносно, бо drizzle-kit
      виконує схему без аліасів. Модулі `app/domain/**` загалом не мають `#`-імпортів, тому `mfaBinding`, якому
      потрібен `#config`, лишається в `mfa-ticket.ts` і брендує результат чистим `asMfaBinding`.
    - Рядкові id сесії та MFA: `SessionId`, `TicketId`, `CompletionId`, `ReservationId`, `AttemptId`.
    - Хешувальна функція приймає лише свій вхідний стан (сирий токен, або `NormalizedRecoveryCode` для кодів
      відновлення) і повертає лише хеш. Репозиторії шукають лише за хешем.
- **Р6. `NormalizedEmail`.**
    - Його створює тільки `normalizeEmail`. `findByEmail`, `createUser` і пошук OAuth-зв'язку приймають
      `NormalizedEmail`, тому забути нормалізацію неможливо. `LOWER()` у SQL лишається як страховка для старих даних.
    - У shared з'являється `EmailInputSchema = 'string.email & string <= 255'`, що замінює три копії.
    - Ненормалізований бренд `EmailSchema` / `Email` видаляється в тій самій фічі.
    - `$type<NormalizedEmail>()` на `oauthAccounts.providerEmail` ставиться лише тоді, коли перевірено, що всі шляхи
      запису нормалізують email.
- **Р7. Одиниці часу.**
    - Вводяться `Milliseconds`, `Seconds`, `UnixMs` у `shared/brand`.
    - Арифметика над брендом дає звичайний `number`, і обгортання в `ms(a + b)` пропустило б `ms(secVal + msVal)`. Тому
      є мінімальний набір операцій: `nowUnixMs()`, `ms()`, `seconds()`, `addMs(at, delta)`, `diffMs(a, b)`, `toMs(s)`,
      `toSecondsFloor(ms)`, `toSecondsCeil(ms)`.
    - **Тривалості (TTL у Redis, `Retry-After`) округлюються вгору** (`toSecondsCeil`), щоб ключ не зник раніше за
      межу. **Моменти часу (`issuedAt`, крок TOTP) округлюються вниз** (`toSecondsFloor`), як зараз.
    - Redis-тести перевіряють фактичний час життя ключа (`TTL` / `PTTL` після запису), а не лише код обгортки.
    - TTL у Redis передаються через типізовані обгортки: `EX` бере `Seconds`, `PX`/`PEXPIRE` бере `Milliseconds`.
    - Конфіг (`config/session.ts`, `throttle-policies.ts`) експортує брендовані значення. Імена `now`/`age` дістають
      суфікси.
    - `TimestampSchema` прибирається в цій же фічі, щоб не було двох типів для одного поняття.
- **Р8. Shared і фронтенд — окрема, необов'язкова фіча.**
    - Бренди на id у відповідях коштують ~108 тестових літералів і типізованих фабрик. Тому спершу фронтенд отримує лише
      `SessionPublicId`, `IsoDateTime`, `Cursor` і `EntityId` у відповідях, а тести — helper `asEntityId()`.
    - Межа цього кроку: спільний `EntityId` у відповіді гарантує формат, але на фронтенді id різних сутностей
      лишаються взаємозамінними. Тому feat-268 лишається окремою, а бренди за сутностями на фронтенді — питанням для
      неї.
    - Брендовані поля query поки не вводяться. Опція для feat-268: `QueryWireValue<T>` знімає бренд
      (`T extends Brand<infer Base, unknown> ? QueryWireValue<Base> : …`). Тоді фронтенд надсилає рядки, а контролер
      отримує `EntityId` прямо з `context.httpData.query`.
    - Типізація path-параметрів через контракт виноситься в окрему пізнішу ідею.
- **Р9. Чистка примітивів.** Без зворотної сумісності (шаблон):
    - `PriceInCents` видаляється (feat-268).
    - `Timestamp` видаляється у feat-267 (його заміняє `UnixMs`).
    - `Email` видаляється у feat-266 (його заміняє `NormalizedEmail`).
    - `PositiveInt`, `NonNegativeInt` і `NonEmptyString` лишаються (рішення власника) як готові будівельні блоки
      шаблону. У feat-268 для кожного в `shared/test` додається тест на приймання й відхилення.
- **Р10. ADR 0007 «Branded types».**
    - ADR фіксує Р1–Р4, Р11, правило «зовнішній рядок стає брендом лише через схему або `parse…`» і заборону
      приведення до бренду поза модулями-конструкторами.
    - Заборону перевіряє **локальне type-aware правило ESLint** (`no-brand-cast`), а не `no-restricted-syntax`.
      AST-правило бачить лише ім'я типу, і його обходять `import { UserId as U }` або `type X = UserId`.
    - Як працює правило: для кожного `TSAsExpression` і `TSTypeAssertion` воно бере через type checker кінцевий тип
      приведення і перевіряє, чи є серед його складових тип із властивістю `' brand'` (форма `Brand` з Р2). Тому
      ловляться аліаси, перейменовані імпорти, `as unknown as UserId`, а також `as UserId | null`. Списку імен брендів
      немає, і новий бренд не може випасти з перевірки.
    - Межа перевірки: правило дивиться на сам тип приведення і на члени його union / intersection (`UserId`,
      `UserId | null`), але **не спускається рекурсивно в поля об'єктів**. Інакше спрацювали б службові приведення на
      кшталт `table as unknown as typeof passwordResetTokens` і `created as Row` у
      `repositories/auth/token-repository.ts:59-83`, де поля рядка вже брендовані. Тест RuleTester фіксує, що такі
      приведення не є помилкою.
    - Typed linting уже ввімкнено: кореневий `eslint.config.ts:32-38` (`strictTypeChecked` + `projectService`),
      `packages/frontend/eslint.config.ts:71`.
    - Винятки за шляхом файлу: модулі-конструктори (`shared/src/brand/**`, `database/ids.ts`, `app/domain/**`) і тести.
      Тому всі конструктори брендів (id, секрети Р5, `normalizeEmail` Р6, обгортки часу Р7) лежать в `app/domain/` або
      `shared/brand`, а не в `services/**`.
    - Правило має власні тести (RuleTester): аліас, перейменований імпорт, `as unknown as`, `<UserId>x` і об'єднання з
      `null` дають помилку; `as const` і приведення до небрендових типів — ні.
    - Правило потрапляє в кореневий конфіг. У `packages/frontend/eslint.config.ts` його додає feat-268, коли бренди
      дійдуть до фронтенду.
- **Р11. Порядок аргументів: спершу власник, `(userId, id)`, на всіх шарах** (погоджено 2026-11-25).
    - Правило: спершу scope (власник), потім ключ рядка (id або інший ключ), потім дані. Тому
      `updateByEndpoint(endpoint, userId, data)` стає `updateByEndpoint(userId, endpoint, data)`.
    - Сервіси вже так написані (`getSubscription(userId, subscriptionId)`, `unlink(userId, …)`).
    - Міняються методи з порядком `(id, userId)`:
        - `push-subscription-repository`: `findByIdAndUserId`, `update`, `updateByEndpoint`, `deactivate`,
          `touchLastUsed`, `delete`, `getLogsBySubscriptionId`;
        - `push-notification-log-repository`: `countsBySubscription`, `latestBySubscriptionIds`;
        - `webauthn-credential-repository`: `rename`, `deleteOne`;
        - `oauth-account-repository`: `deleteByIdForUser`;
        - `totp-factor-repository`: `consumeStep`;
        - `push-subscription-statistics-service`: `(subscriptionId, userId)`.

        `notification-repository.markRead(userId, id)` уже відповідає правилу.

    - Назви методів збігаються з порядком: `findByIdAndUserId` → `findForUser(userId, id)`,
      `deleteByIdForUser` → `deleteForUser(userId, id)`.
    - Після Р3 переставлені id різних сутностей (`UserId` ↔ `PushSubscriptionId`) не компілюються, тож правило
      відповідає за читабельність, а безпеку дають бренди.
    - Два id одного бренду (адміністратор і цільовий користувач) передаються лише об'єктом-параметром, як у
      `mfaResetService.reset({ actor, targetUserId, … })` і `roleAssignmentService.assign({ actor, targetUserId, … })`.
    - Правило записується в ADR 0007, tutorial `adding-a-feature` (обидві локалі) і скіл `backend-feature`.
- **Р12. Порядок фіч.**
    - `shared/brand` (`Brand`, `isValidEntityId`) з'являється у feat-262. Тому feat-267 залежить лише від feat-262 і може
      йти паралельно з feat-263.
    - ADR 0007 і ESLint-правило вводить feat-263. Правило розпізнає бренд за формою типу, а не за списком, тому бренди
      часу з feat-267 потрапляють під нього самі, хоч би яка фіча змерджилася першою. Якщо feat-267 іде раніше,
      приведення до брендів часу живуть лише в її модулях-конструкторах.

- **Р13. Сесія і Redis: бренд лише на межі app.**
    - Vendor-типи `SessionData` / `SessionInfo` (`vendor/types/types.d.ts:300`) **не змінюються**: `userId: string`.
      Vendor-ядро не знає про бренди app-шару, тож бренд не може потрапити ні в JSON у Redis, ні в `as SessionInfo` у
      `redis-session-storage.ts` чи `ws-session-auth.ts`.
    - `UserId` з'являється лише через `parseUserId` у місцях, де app читає id із сесії:
        - `requireUserId` (HTTP, `controllers/shared/require-user-id.ts`);
        - `permission-guard`;
        - `ws-coordinator`;
        - `ws-session-auth.ts:34-86`, на обох записах із Redis: WS-токен `auth:ws:${token}` (`{ sessionId, userId,
userToken }`, `:34`) і `SessionInfo` (`:63`). `checkSessionToken(userId, userToken)` (`:86`) бере `userId` з
          першого.
    - **Запис сесії**: app передає у vendor рядок через `toEntityId(userId)`, ніколи не `UserId`. Компілятор це
      гарантує, бо vendor-тип очікує `string`, а `UserId` (`bigint`) туди не присвоюється.
    - Сесія з невалідним `userId` вважається без користувача (як зараз, коли `userId` немає) і пишеться в лог.

## Кроки

### feat-262: спільний валідатор id (shared + backend + frontend guard, без брендів id)

Відмова від `'0'` і `'007'` змінює контракт. Колонка «Зараз» — очікувана поточна відповідь; перший тест фіксує її
до зміни коду, і якщо вона інша, таблиця виправляється. Колонка «Після» — єдина поведінка після feat-262, вона
збігається з тестами парсера нижче.

Типи входів у колонці «Зараз»:

- **(п)** — вхід іде через `parseEntityId`. `'0'` дає `0n` і доходить до запиту (порожньо або 404), `'007'` дає `7n`
  і читає рядок 7, `2^63` уже відкидається.
- **(с)** — вхід перевіряє схема з `ENTITY_ID_PATTERN` / локальним regex. `'0'` і `'007'` уже 422, `2^63` проходить.

**`0` не є допустимим значенням ні для id, ні для курсора чи `before`.** Фронтенд надсилає лише курсори, які видав
сервер (`frontend/src/utils/api.ts:267-280, 354-359`). Курсор будується з id рядка, а id ≥ 1. Першу сторінку
запитують без параметра. Для кожного курсора і `before` є тест «значення `0` відкидається».

| Вхід                            | Контролер                                                           | Зараз                                                                                                                 | Після для `'0'`, `'007'`, `2^63`                                           |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `?userId`, `?cursor`            | `admin-user-controller.ts:25,34`                                    | (п)                                                                                                                   | 400 (`userId` / `cursor must be a numeric string`)                         |
| `:id` (2 методи)                | `admin-user-controller.ts:67,93`                                    | (п)                                                                                                                   | 400 `invalid_user_id`                                                      |
| `?userId`, `?cursor`            | `admin-online-history-controller.ts:17,26`                          | (п)                                                                                                                   | 400                                                                        |
| `:id`                           | `admin-online-user-controller.ts:23`                                | (п)                                                                                                                   | 400 `Invalid user id`                                                      |
| `?actorUserId`, `?targetUserId` | `admin-audit-events-controller.ts:19-23`                            | (с); `2^63` далі дає 400 `invalid_user_id`                                                                            | 422 від схеми                                                              |
| `?cursor` (декодований id)      | `decodeAuditCursor`                                                 | власна перевірка: `'0'` і `'007'` відкидає `ID_TEXT`                                                                  | курсор невалідний, як зараз для чужого курсора                             |
| `:id`                           | `admin-knowledge-base-controller.ts:28`                             | (п)                                                                                                                   | 400 `Invalid ID`                                                           |
| `:articleId`                    | `support-controller.ts:54`                                          | (п)                                                                                                                   | 400 `Invalid articleId`                                                    |
| `?before`                       | `support-controller.ts:27-28` (`query/support.ts:14`)               | (с), 18 цифр: `2^63` теж 422                                                                                          | 422 від схеми (сервіс не викликає `parseEntityId`, межу тримає лише схема) |
| `:subscriptionId`               | `push-subscription-controller.ts:41`                                | (п)                                                                                                                   | 404 `Subscription not found`                                               |
| `:id`                           | `passkey-controller.ts:32`                                          | (п) + `id > 0n`: `'0'` уже 404                                                                                        | 404                                                                        |
| `:id`                           | `notification-controller.ts:27`                                     | (п) + `id > 0n`: `'0'` уже 404                                                                                        | 404                                                                        |
| `?before`                       | `notification-controller.ts:39-48` (`query/notifications.ts:14`)    | (с); `2^63` далі дає 400 `invalid_cursor`                                                                             | 422 від схеми                                                              |
| body `upTo`                     | `notification-controller.ts:79-82` (`notifications/requests.ts:10`) | (с); `2^63` далі дає 400 `invalid_up_to`                                                                              | 422 від схеми                                                              |
| body `id`                       | `sign-in-methods-controller.ts:29`                                  | (с); `2^63` далі дає 404                                                                                              | 422 від схеми                                                              |
| `?userId`                       | `llm-usage-controller.ts:8-15`                                      | `BigInt` у try/catch після `.trim()`: `'abc'` і `'  '` — 200 без фільтра; `'0x10'`, `'-5'`, `' 1'` — фільтр 16, −5, 1 | 400. `''` або відсутній — 200 з усіма рядками                              |

Відмова схеми — це `ValidationError`, який `classify-error` мапить у 422 `validation_failed`
(`vendor/utils/network/errors/classify-error.spec.ts:60-68`). 400 дає лише контролер (`badRequest`).

Після feat-262 перевірки `id > 0n` у `passkey-controller` і `notification-controller` стають зайвими і
прибираються.

- Новий subpath `shared/brand` без ArkType: `Brand<T, Id>`, `isValidEntityId`, тест двосторонньої рівності з
  `EntityIdSchema.infer` (Р2).
- `ENTITY_ID_PATTERN` = `/^[1-9]\d{0,18}$/`. `EntityIdSchema` перевіряє `.narrow(isValidEntityId)`. Паритетний тест
  `contracts.test.js:169-174` переписується на `isValidEntityId` і отримує випадки `9223372036854775807` /
  `9223372036854775808`.
- `parseEntityId` використовує `isValidEntityId`: `'0'` і `'007'` дають `null`. `parse-id.spec.ts` оновлюється
  (рядок `['0', 0n]` прибирається).
- `frontend/src/utils/ws-payload-guards.ts:25` викликає `isValidEntityId`, імпортований зі `shared/brand` як значення.
- Frontend vitest-тест (`utils/__tests__/ws-payload-guards.spec.ts`): payload з id `9223372036854775807` приймається;
  `9223372036854775808`, `'0'`, `'007'`, `' 1'` відкидаються.
- Локальні дублікати прибираються. `NOTIFICATION_ID_PATTERN` (`notifications/requests.ts`, `query/notifications.ts`),
  `IdSchema` у `responses/notifications-controller.ts`, `before?` у `query/support.ts` і `ENTITY_ID_PATTERN` у
  `query/admin-audit-events.ts` замінює `EntityIdStringSchema`. `ID_TEXT` / `MAX_POSTGRES_BIGINT` у
  `decodeAuditCursor` замінює `isValidEntityId`. `ProfileRevisionSchema` і
  `REVISION_PATTERN` лишаються з власним предикатом: `'0'` означає профіль без збереженого рядка налаштувань.
- `isCanonicalEntityId` прибирається, викликачі переходять на `isValidEntityId`.
- `sign-in-methods-controller.ts:29` переходить на `parseEntityId`. Завеликий id відкидає схема (422) ще до сервісу.
- `llm-usage-controller.ts:8-15`, за взірцем `admin-user-controller.ts:24-30`: без `.trim()`; `''` або відсутній
  `userId` означає «без фільтра»; при `parsed === null` (зокрема `' 1'` і `'  '`) повертається
  `badRequest('userId must be a numeric string')`.
- Тести парсера: `9223372036854775807` (максимум) приймається; `9223372036854775808` (максимум + 1), `0x10`, `-5`,
  `0`, `007`, `abc`, `''`, `' 1'`, `'1 '` відкидаються.
- Тести маршрутів (PG) за таблицею вище: кожен рядок дає вказану відповідь, а не 500 чи 200 без фільтра.
- AI usage: окремі тести на запит без `userId` і з `userId=''` (200, усі рядки) та з невалідним `userId`, зокрема
  `' 1'` і `'  '` (400).
- Support: `before=9223372036854775808` дає 422, а не 500 (PG).
- Тести курсорів: `cursor=0` / `before=0` відкидаються на кожному маршруті з таблиці.
- DoD цієї фічі окремо: `check-bundle-graph` (у складі `make check`) проходить, тобто імпорт `shared/brand` на фронтенді
  не тягне ArkType; `pnpm --filter frontend test` з тестом вище; `make test-pg` для тестів маршрутів.
- Документація: `documentation/backend/` (обидві локалі), де описано формат id.

### feat-263: бренди id — інфраструктура + users/auth (залежить від feat-262)

- **Перший крок — наскрізний сценарій unlink** (`DELETE` способу входу): `UserId` і `OAuthAccountId` від контролера
  через сервіс до `oauth-account-repository`, разом із FK на `users.id`, яких він торкається.
    - Критерії успіху: у Drizzle `1.0.0-rc.5` з `.$type<Brand<bigint, …>>()` працюють select, insert, `returning`,
      `eq`, `inArray` і RQB v2 (`defineRelations` у `database/relations.ts`), у тому числі в перехідному стані, коли
      `users.id` брендований, а FK `user_id` таблиць feat-264 ще ні.
    - Тест типів: переставлені `UserId` і `OAuthAccountId` не компілюються.
    - Якщо `defineRelations` вимагає однакового типу на обох кінцях, `UserId` разом з усіма FK `user_id` проводиться
      окремим комітом, і сигнатури `userId` у доменах feat-264 міняються в ньому ж.
    - Лише після цього сценарію бренди поширюються на решту таблиць auth.
- ADR 0007 (Р10, Р11).
- `database/ids.ts` (оголошення типів), `app/domain/ids.ts` (реекспорт, конструктори `parseUserId`,
  `parseOAuthAccountId`, …, `toEntityId`).
- `$type` **лише на таблиці домену**: `users`, `user_preferences`, `user_online`, `oauth_*`, `email_*`,
  `password_reset_tokens` (і решта одноразових токенів через `OneTimeTokenRowId`), `totp_factors`, `mfa_recovery_codes`,
  `webauthn_credentials`, `sms_auth_challenges` (`SmsChallengeId`).
- Сигнатури репозиторіїв і сервісів users, sessions, auth, oauth, mfa, passkeys, а також `requireUserId` (через
  `parseUserId`), `permission-guard`, `ws-coordinator`.
- Сесія за Р13: vendor-типи сесії не змінюються; `parseUserId` у `requireUserId`, `permission-guard`, `ws-coordinator`,
  `ws-session-auth` (обидва записи); запис сесії через `toEntityId`.
- Redis-тести: чинна сесія читається і дає `UserId`; сесія з невалідним `userId` (`'abc'`, `'0'`, `2^63`) вважається
  без користувача.
- Порядок аргументів за Р11: `webauthn-credential`, `oauth-account`, `totp-factor`.
- ESLint-правило `no-brand-cast` (Р10) з тестами RuleTester.
- Оновити `documentation/en/backend/adding-a-feature.md` (+ uk) і скіл `backend-feature`: репозиторій і трансформер
  працюють із брендованими id, порядок аргументів за Р11. AGENTS.md цього вимагає.

### feat-264: бренди id — notifications, push, support, AI, admin, audit (залежить від feat-263)

- `$type` на таблиці цих доменів і їхні сигнатури.
- Порядок аргументів за Р11: усі методи `push-subscription-repository` і `push-notification-log-repository` з
  переліку Р11, `push-subscription-statistics-service`. Після фічі в цих файлах немає жодного методу з `userId` другим.

### feat-265: секрети за станами (залежить від feat-263)

- Р5: `one-time-token.ts`, `token-repository.ts`, `recovery-codes.ts`, `otp-verification-hash.ts`,
  `session-token-check.ts`, `ws-session-revocation.ts`, `generate-ws-token-service.ts`, `mfa-ticket.ts`
  (`MfaBindValue` / `MfaBinding`), `mfa-sign-in.ts`, `oauth-service.ts` (`sessionBindingHash`).
- `users.session_token`: `$type<SessionToken>()` і `$defaultFn(newSessionToken)`.
- Тести типів (`@ts-expect-error`): сирий токен не приймається у `findByTokenHash`, хеш не приймається в `hashToken`,
  сирий код відновлення не приймається в `hashRecoveryCode`, сире значення `mfa_bind` не порівнюється з прив'язкою.
- Redis-тести: сесія з `userToken` читається після зміни типів, як і до неї.

### feat-266: `NormalizedEmail` (залежить від feat-263)

- Р6: `auth-normalize.ts`, 9 викликів, `user-repository`, `oauth-service.ts:240` (домен), `account-claim-service`.
- `EmailInputSchema` у shared замість трьох копій. `EmailSchema` / `Email` видаляються з `brands/primitives.ts`.
- `providerEmail`: перевірити всі шляхи запису, перш ніж ставити `$type<NormalizedEmail>()`.

### feat-267: одиниці часу (залежить від feat-262; можна паралельно з feat-263)

- Р7: `Milliseconds` / `Seconds` / `UnixMs` і операції в `shared/brand`, типізовані обгортки TTL у Redis,
  `config/session.ts`, `throttle-policies.ts`, `mfa-ticket.ts`, `sms-challenge.ts`, `redis-lease.ts`,
  `llm-budget-service.ts`, `generate-ws-token-service.ts` (літерал `60`), `Retry-After`.
- `TimestampSchema` / `Timestamp` видаляються з `brands/primitives.ts`.
- Redis-тести перевіряють фактичний `TTL` / `PTTL` ключів після запису через обгортки (сесія, MFA-тікет, lease,
  бюджет LLM). Межі: `Retry-After` і TTL не менші за точне значення, `issuedAt` не більший за поточну секунду.
- Документація scheduler / config за потреби.

### feat-268: shared і фронтенд (необов'язкова, залежить від feat-263, рішення Р8)

- `SessionPublicId`, `IsoDateTime` (`string.date.iso` + бренд), `Cursor`, `EntityId` у схемах відповідей.
- `ws-payload-guards.ts` звужує до брендів. `stores/user.ts` і `stores/push.ts` беруть типи з `shared/responses`.
- Helper `asEntityId()` для тестів, оновлення фабрик.
- ESLint-правило Р10 у `packages/frontend/eslint.config.ts`.
- Опція: `QueryWireValue` знімає бренд (Р8).
- Р9: `PriceInCents` видаляється, тести для `PositiveInt` / `NonNegativeInt` / `NonEmptyString`.

## Перевірка (Definition of Done)

- `make check` для кожної фічі: `typecheck` (зокрема `__tests__` фронтенду), `check-bundle-graph`.
- `make test-pg` з лічильниками executed/skipped для feat-262–feat-266: вони зачіпають репозиторії й межі `bigint`.
- `make test-redis` з лічильниками executed/skipped для feat-263 (`SessionData`, `ws-coordinator`), feat-265
  (`session-token-check`, `mfa-ticket`, `ws-session-revocation`) і feat-267 (TTL-обгортки, `redis-lease`,
  `llm-budget-service`).
- `pnpm --filter backend db:generate` для feat-263 і feat-264: drizzle-kit парсить схему без помилок і не генерує
  жодної міграції (`$type` змінює лише типи).
- Тести типів з `@ts-expect-error` на кожен новий бренд (за взірцем `shared-brands.spec.ts`).
- `pnpm docs:build && pnpm docs:verify`, коли змінено документацію.
- Рантайм-поведінка не змінюється, крім баг-фіксу feat-262. Бренди існують лише на рівні типів.

## Ризики

- **Обсяг диффу.** feat-263/264 зачіпають сотні сигнатур. Ризик знижує те, що `$type` у схемі дає бренд «згори», а
  помилки компілятора самі показують місця, які треба змінити. Фіча ділиться за доменами, щоб PR лишалися
  переглядними.
- **Drizzle rc.** `.$type<Brand<bigint,…>>()` у `1.0.0-rc.5` може не пройти через RQB v2 у перехідному стані. Це перший
  крок feat-263, а запасний варіант описано там же.
- **arktype змінить форму `Brand`.** Від цього захищає тест двосторонньої рівності (Р2).
- **Втеча через `as`.** Від неї захищає type-aware ESLint-правило (Р10), зокрема через аліаси.
- **ArkType у бандлі фронтенду.** Від нього захищають `shared/brand` без залежностей і `check-bundle-graph`.

## Поза планом

- `TokenCount` / `BudgetCallKind` у LLM-бюджеті: користь мала, можна додати у feat-264, якщо дешево.
- Брендовані ключі Redis і S3 (`RedisKey`, `S3ObjectKey`): ключі збираються інлайн, але помилок поки не видно.
- `IpAddress`, `UserAgent`, `Locale`: це рядки без інваріанту, і бренд тут нічого не ловить.
- Типізовані path-параметри в `contracts/core.ts`: окрема ідея, бо зачіпає ADR 0005.
