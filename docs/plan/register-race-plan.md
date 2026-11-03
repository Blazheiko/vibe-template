# Гонка при реєстрації: unique violation дає 500

Пріоритет: низький–середній. Орієнтовний розмір: S (~3 файли коду + 2 тестові).

## Проблема

`registerEmailFlow` (`packages/backend/src/app/services/auth/auth-service.ts`) працює за схемою
«перевірив, потім вставив» без блокування:

1. throttle → `hashPassword`;
2. `userRepository.findByEmail(email)` → `undefined` в обох паралельних запитах;
3. `persistRegisteredUser` → `userRepository.create`. Другий insert падає на
   `users_email_unique_non_null_idx` (`LOWER(email)`, `database/schema.ts`), виняток не
   перехоплений → клієнт отримує 500 `internal_error` замість загальної відповіді.

Вікно гонки — проміжок між `findByEmail` і `create`. Хешування відбувається до `findByEmail`,
тож воно це вікно не розширює; на практиці гонку дає майже одночасна пара запитів (double-submit,
повтор клієнтом, скрипт).

Хелпер `isUniqueViolation` уже є (`app/repositories/db-errors.ts`) і використовується в
`email-verification-service.ts` (прив'язка email) та `oauth-service.ts` (створення OAuth-юзера).

### Де ще та сама гонка

| Місце | Перевірка | Запис | Зараз | Має бути |
|---|---|---|---|---|
| Реєстрація email (strict і non-strict) | `findByEmail` | `create` | 500 | `GENERIC_EMAIL_REGISTRATION_MESSAGE`, як для зайнятої адреси |
| `completePhoneRegistration` | `findByPhone` | `create` | 500 | 409 `Phone already exist` (як у перевірці вище) |
| `confirmPhoneLink` | `phoneExistsForOtherUser` | `updateIfSessionToken` | 500 | 409 `Phone is already linked to another account` |
| OAuth new user (`oauth-service.ts`) | — | — | ✅ уже перехоплено з повтором | — |

### Наслідки

- Дані не псуються: унікальні обмеження працюють.
- 500 у логах/Sentry і порушення контракту відповіді.
- Слабкий enumeration-сигнал: 500 замість загальної відповіді каже, що адресу саме зараз
  реєструють.

## План

### 0. Процес (AGENTS.md)

- PR у `main` з новим записом `feat-100` у `feature_list.json`
  (`in_progress`, гілка `fix/feat-100-register-race`).
- `progress.md` на гілці фічі.

### 1. `persistRegisteredUser`: перехопити unique violation

```ts
let userCreated: UserRow
try {
    userCreated = await userRepository.create({ ... })
} catch (err: unknown) {
    // A concurrent registration took the email or phone between the lookup and the insert.
    if (isUniqueViolation(err)) return Result.err(conflict('Account already exists'))
    throw err
}
```

Перехоплення стоїть навколо самого `create`, тобто до відправки листа верифікації, до
`markInvalidated` challenge, до `session.destroySession` і до `auth.login`. У програшного
запиту побічних ефектів немає.

**Свідоме припущення:** перехоплюється будь-який `23505` без розбору `constraint_name`. Для
поточної схеми це безпечно: в email-реєстрації `phone = null`, у phone-реєстрації
`email = null`, а колізія `session_token` (nanoid, 24 символи) практично неможлива. Якщо до
`users` додадуть нове унікальне поле, яке заповнюється при реєстрації, це припущення треба
переглянути (перевіряти ім'я індексу). Залишити коментар у коді з цим припущенням.

### 2. Відповідь для кожного виклику

**Email, strict-режим** (`authConfig.strictRegistration = true`): обидва запити, і переможець,
і програвший, отримують `{ status: 'success', message: GENERIC_EMAIL_REGISTRATION_MESSAGE }`.
Програвший не знищує сесію, як і в гілці `existResult !== undefined`.

**Email, non-strict-режим:** відповіді різні, і це очікувано:
- переможець: створює сесію, `auth.login`, повертає `AuthSuccessPayload` з користувачем;
- програвший: `Conflict` з `finalizeRegistration` → загальне повідомлення, **без**
  `session.destroySession` і **без** `auth.login`.

Це та сама поведінка, що й для вже зайнятої адреси в non-strict режимі.

**`completePhoneRegistration`:** `conflict('Phone already exist')`, той самий текст, що й у
перевірці перед insert. `markInvalidated`, `destroySession` і `auth.login` не викликаються.

**Про час відповіді:** обидва запити хешують пароль, тож дорога операція в них спільна. Але
однакової тривалості це не гарантує: конфліктний insert може чекати, поки закомітиться
конкурентний запис. Мета фічі — правильний контракт помилки, не вирівнювання часу.

### 3. `confirmPhoneLink`

Обгорнути `updateIfSessionToken` так само → 409 `Phone is already linked to another account`.

Компроміс: `confirmChallenge` виконується до update, тож у програшного запиту challenge уже
витрачено. Користувач починає прив'язку заново. Перенесення confirm + update в одну транзакцію
— окрема задача, у цю фічу не входить.

### 4. Тести

#### Детермінований бар'єр

Сам по собі `Promise.all` не гарантує гонки: другий запит може прочитати вже створеного
користувача, і тест пройде, не зачепивши новий `catch`. Потрібен бар'єр **після перевірки,
перед записом**: обидва запити мають пройти перевірку, і лише тоді будь-який із них пише.

Використати `bothReadBeforeEitherWrites` з `one-time-token-race.pg.test.ts` (спай на методі
перевірки, що тримає першого читача, доки не прочитає другий). Винести його в спільний
тестовий хелпер (наприклад `app/services/auth/__test-utils__/race.ts`), щоб не дублювати.

| Сценарій | Бар'єр на | Підготовка |
|---|---|---|
| Реєстрація email | `userRepository.findByEmail` | Два запити з однаковим email (різний регістр — окремий кейс на `LOWER`) |
| Phone completion | `userRepository.findByPhone` | Два **окремі** підтверджені challenge на один номер у двох різних сесіях |
| Link phone | `userRepository.phoneExistsForOtherUser` | Два **різні** акаунти, кожен зі своєю сесією і своїм підтвердженим challenge на один номер |

В останніх двох рядках challenge мають бути окремими. Інакше другий запит відсіється як
повторне використання challenge, і тест перевірятиме не конфлікт унікальності.

Створювати такі challenge напряму в БД (вже підтверджені, `confirmedAt` заповнено,
`metadata.sessionId` / `userId` своєї сесії), а не через `start*`: `issueSmsChallenge` викликає
`invalidatePendingForPhoneFlow`, тож другий старт через API інвалідує перший challenge.

#### pg-тести (`register-race.pg.test.ts`)

- **Email strict:** обидва результати `ok` із загальним повідомленням; у `users` один рядок.
- **Email non-strict:** один `AuthSuccessPayload`, один загальний; у `users` один рядок;
  `auth.login` викликано рівно один раз.
- **Phone completion:** один ok, один 409 `Phone already exist`; один користувач із цим
  номером; challenge програвшого не інвалідовано.
- **Link phone:** один ok, один 409 `Phone is already linked to another account`; номер
  належить рівно одному акаунту, у другого `phone` не змінився.
- **Mutation-перевірка:** без `catch` кожен із цих тестів падає з 500 або `rejects`.

#### Unit (`auth-service.regression.spec.ts`)

`create` / `updateIfSessionToken` відхиляються з `{ code: '23505' }` і з Drizzle-обгорткою
(код у `cause`):
- email strict і non-strict → загальна відповідь; лист не відправлено; `destroySession` і
  `auth.login` не викликано;
- phone completion → 409; `markInvalidated` не викликано;
- link phone → 409;
- будь-яка інша помилка й далі пробрасується (`rejects`).

### 5. Документація

Перевірити `documentation/backend/` (сторінку auth): якщо описані відповіді реєстрації або 409
для phone, додати рядок про паралельні запити. Нових маршрутів, env, міграцій немає.

### 6. Definition of Done

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `test:pg` — зелені.
- Вручну на dist, два паралельні `curl` на реєстрацію з одним email:
  - strict: обидва 200 із загальним повідомленням, в `users` один рядок;
  - non-strict: один 200 з користувачем і сесією, один 200 із загальним повідомленням, в
    `users` один рядок.
  Ручна перевірка гонку не гарантує; детермінованість забезпечують pg-тести.
- `pnpm docs:build && pnpm docs:verify`, якщо документацію змінено.
- PR → зелений CI → merge commit; окремий PR «Mark feat-100 done» з `evidence` у
  `feature_list.json`.
