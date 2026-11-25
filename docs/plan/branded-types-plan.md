# План: branded types і value objects

**Статус: погоджено власником** (2026-11-25): Р1–Р12. Р9 уточнено: `PositiveInt`, `NonNegativeInt`, `NonEmptyString`
лишаються. Р11: спершу власник, `(userId, id)`, на всіх шарах. Фічі: `feat-262`…`feat-268`.

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
- **Валідаторів id три, і вони розходяться:**
    - `parseEntityId` (`controllers/shared/parse-id.ts`): `/^\d{1,19}$/` плюс межа PG. Він **приймає `'0'` і `'007'`**,
      і `parse-id.spec.ts:10` вважає `['0', 0n]` валідним.
    - `ENTITY_ID_PATTERN` (`shared/src/patterns/index.ts:5`): `/^[1-9]\d*$/` **без верхньої межі**. Його використовують
      `EntityIdSchema` (паритет перевіряє `shared/test/contracts.test.js:169-174`), query-схеми й
      `frontend/src/utils/ws-payload-guards.ts:25`.
    - `isCanonicalEntityId` (`vendor/utils/helpers/entity-id.ts`).

    Локальні regex, що дублюють id: `NOTIFICATION_ID_PATTERN` (`schemas/notifications/requests.ts:5`), `IdSchema` у
    `responses/notifications-controller.ts:6`, `before?` у `query/support.ts:14`. `ProfileRevisionSchema` і
    `REVISION_PATTERN` (`ws-payload-guards.ts:90`) **не є дублікатами**: ревізія спеціально дозволяє `'0'`, коли
    `user_preferences` ще не створено.

- **Два баги на межі `bigint`:**
    - `controllers/http/auth/sign-in-methods-controller.ts:29` робить `BigInt(payload.id)` над `EntityIdSchema`, де немає
      верхньої межі: `9223372036854775808` дає 500 (клас feat-161).
    - `controllers/http/ai/usage/llm-usage-controller.ts:8-15` робить `BigInt(userId.trim())` у
      `catch { /* ignore invalid */ }`. Помилка тиха: невалідний `userId` (`abc`, а також `0x10` і `-5`, які `BigInt`
      приймає) знімає фільтр, і відповідь 200 повертає всі рядки.

**Секрети (усе `string`).**

- Сирий токен і його хеш мають той самий тип: `hashToken(token): string`, `findUsableToken(repo, secret)`,
  `ITokenRepository.findByTokenHash(tokenHash: string)`. Сирий токен, переданий у `findByTokenHash`, компілюється.
- Код відновлення проходить три стани в одному `string`: сирий, нормалізований (`normalizeRecoveryCode`) і хеш
  (`hashRecoveryCode`). Те саме з OTP (`verifyOtpVerificationCode(code, expectedHash)`).
- `mfa-ticket.ts:75-81` має `mfaBinding(bindValue)`, тобто HMAC сирого значення cookie `mfa_bind`. Сире значення і
  прив'язка обидва мають тип `string`.
- `checkSessionToken(userId: string, userToken: string)` і `isSessionStored(sessionId: string, userToken: string)`
  приймають по два рядки. Ключ Redis `session:${userToken}:${sessionId}` залежить від порядку аргументів.
- `users.session_token` (`schema.ts:89`) має `.$defaultFn(() => nanoid())`.

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
    - `EntityIdSchema` перевіряє те саме через `.narrow(isValidEntityId)`, а `parseEntityId` і `ws-payload-guards` викликають
      цю ж функцію. Паритетний тест у `contracts.test.js` порівнює `isValidEntityId` зі схемою, а не regex зі схемою.
    - `'0'` і `'007'` не є id.
    - У feat-263 `parseId<B>(raw): B | null` замінює `parseEntityId`, `isCanonicalEntityId` і всі `BigInt(x)` над
      зовнішніми даними, зокрема `requireUserId`.
    - На дроті бренд лишається один — `EntityId` (рядок). Перетворення `EntityId ↔ UserId` роблять лише `parseId` і
      `toEntityId` (у трансформерах).
- **Р5. Секрети за станами.**
    - Вводяться `RawToken` / `TokenHash`, `RawRecoveryCode` / `NormalizedRecoveryCode` / `RecoveryCodeHash`,
      `OtpCode` / `OtpHash` і `MfaBindValue` / `MfaBinding` (cookie `mfa_bind` і її HMAC).
    - `SessionToken` — це поле `users.session_token` і `userToken` у сесії. Дефолт колонки викликає конструктор
      `newSessionToken()` замість голого `nanoid()`.
    - Рядкові id сесії та MFA: `SessionId`, `TicketId`, `CompletionId`, `ReservationId`, `AttemptId`.
    - Хешувальні функції приймають лише сирий стан і повертають лише хеш, а репозиторії шукають лише за хешем.
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
    - **TTL у Redis і `Retry-After` округлюються вгору** (`toSecondsCeil`), щоб ключ не зник раніше за межу.
    - TTL у Redis передаються через типізовані обгортки: `EX` бере `Seconds`, `PX`/`PEXPIRE` бере `Milliseconds`.
    - Конфіг (`config/session.ts`, `throttle-policies.ts`) експортує брендовані значення. Імена `now`/`age` дістають
      суфікси.
    - `TimestampSchema` прибирається в цій же фічі, щоб не було двох типів для одного поняття.
- **Р8. Shared і фронтенд — окрема, необов'язкова фіча.**
    - Бренди на id у відповідях коштують ~108 тестових літералів і типізованих фабрик. Тому спершу фронтенд отримує лише
      `SessionPublicId`, `IsoDateTime`, `Cursor` і `EntityId` у відповідях, а тести — helper `asEntityId()`.
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
    - ESLint `no-restricted-syntax` забороняє `TSAsExpression` і `TSTypeAssertion` до брендового типу, зокрема
      `as unknown as UserId`. Винятки: модулі-конструктори й тести.
    - Імена брендів беруться з одного списку, що лежить поруч із брендами. Новий бренд додається туди, тож не випадає з
      перевірки.
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
    - ADR 0007 і ESLint-правило вводить feat-263. Якщо feat-267 змерджиться раніше, вона додає своїх бренди часу в
      список правила, коли воно з'явиться, а feat-263 додає правило з уже наявними брендами часу.

## Кроки

### feat-262: один валідатор id і `shared/brand` (баг-фікс, без брендів id)

- Новий subpath `shared/brand` без ArkType: `Brand<T, Id>`, `isValidEntityId`, тест двосторонньої рівності з
  `EntityIdSchema.infer` (Р2).
- `ENTITY_ID_PATTERN` = `/^[1-9]\d{0,18}$/`. `EntityIdSchema` перевіряє `.narrow(isValidEntityId)`. Паритетний тест
  `contracts.test.js:169-174` переписується на `isValidEntityId` і отримує випадки `9223372036854775807` /
  `9223372036854775808`.
- `parseEntityId` використовує `isValidEntityId`: `'0'` і `'007'` дають `null`. `parse-id.spec.ts` оновлюється. Перевірити, що
  жоден контролер не покладається на `'0'` (курсори, `before?`).
- `frontend/src/utils/ws-payload-guards.ts:25` викликає `isValidEntityId`.
- Локальні дублікати прибираються: `NOTIFICATION_ID_PATTERN`, `IdSchema` у `responses/notifications-controller.ts`,
  `before?` у `query/support.ts`. `ProfileRevisionSchema` і `REVISION_PATTERN` лишаються.
- `isCanonicalEntityId` прибирається, викликачі переходять на `isValidEntityId`.
- `sign-in-methods-controller.ts:29` переходить на `parseEntityId` (404, як для чужого id).
- `llm-usage-controller.ts:8-15`: при `parsed === null` повертається `badRequest('userId must be a numeric string')`,
  за взірцем `admin-user-controller.ts:24-30`.
- Тести: `9223372036854775808`, `0x10`, `-5`, `0`, `007`, `abc` дають 400 або 404, а не 500 чи 200 без фільтра (PG).
- Документація: `documentation/backend/` (обидві локалі), де описано формат id.

### feat-263: бренди id — інфраструктура + users/auth (залежить від feat-262)

- Перший крок — перевірити `.$type<Brand<bigint, …>>()` у Drizzle `1.0.0-rc.5`: `eq`, `inArray`, `insert`, RQB v2
  (`defineRelations` у `database/relations.ts`) у перехідному стані, коли `users.id` брендований, а FK `user_id`
  таблиць feat-264 ще ні. Якщо `defineRelations` вимагає однакового типу на обох кінцях, `UserId` разом із усіма FK
  `user_id` проводиться окремим першим комітом, а сигнатури `userId` у feat-264-доменах міняються в ньому ж.
- ADR 0007 (Р10, Р11).
- `database/ids.ts` (оголошення типів), `app/domain/ids.ts` (реекспорт, `parseId`, `toEntityId`).
- `$type` **лише на таблиці домену**: `users`, `user_preferences`, `user_online`, `oauth_*`, `email_*`,
  `password_reset_tokens` (і решта одноразових токенів через `OneTimeTokenRowId`), `totp_factors`, `mfa_recovery_codes`,
  `webauthn_credentials`, `sms_auth_challenges` (`SmsChallengeId`).
- Сигнатури репозиторіїв і сервісів users, sessions, auth, oauth, mfa, passkeys, а також `requireUserId` (через
  `parseId<UserId>`), `permission-guard`, `ws-coordinator`, `SessionData.userId`.
- Порядок аргументів за Р11: `webauthn-credential`, `oauth-account`, `totp-factor`.
- ESLint-правило (Р10).
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
  сире значення `mfa_bind` не порівнюється з прив'язкою.

### feat-266: `NormalizedEmail` (залежить від feat-263)

- Р6: `auth-normalize.ts`, 9 викликів, `user-repository`, `oauth-service.ts:240` (домен), `account-claim-service`.
- `EmailInputSchema` у shared замість трьох копій. `EmailSchema` / `Email` видаляються з `brands/primitives.ts`.
- `providerEmail`: перевірити всі шляхи запису, перш ніж ставити `$type<NormalizedEmail>()`.

### feat-267: одиниці часу (залежить від feat-262; можна паралельно з feat-263)

- Р7: `Milliseconds` / `Seconds` / `UnixMs` і операції в `shared/brand`, типізовані обгортки TTL у Redis,
  `config/session.ts`, `throttle-policies.ts`, `mfa-ticket.ts`, `sms-challenge.ts`, `redis-lease.ts`,
  `llm-budget-service.ts`, `generate-ws-token-service.ts` (літерал `60`), `Retry-After`.
- `TimestampSchema` / `Timestamp` видаляються з `brands/primitives.ts`.
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
- **Втеча через `as`.** Від неї захищає ESLint-правило (Р10).
- **ArkType у бандлі фронтенду.** Від нього захищають `shared/brand` без залежностей і `check-bundle-graph`.

## Поза планом

- `TokenCount` / `BudgetCallKind` у LLM-бюджеті: користь мала, можна додати у feat-264, якщо дешево.
- Брендовані ключі Redis і S3 (`RedisKey`, `S3ObjectKey`): ключі збираються інлайн, але помилок поки не видно.
- `IpAddress`, `UserAgent`, `Locale`: це рядки без інваріанту, і бренд тут нічого не ловить.
- Типізовані path-параметри в `contracts/core.ts`: окрема ідея, бо зачіпає ADR 0005.
