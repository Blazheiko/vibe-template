# Passkeys і MFA — покроковий task list

**Редакція 3** (2026-11-22): passkey-only гілка B — лише X2, S2 самостійний (пароль + TOTP); два очікування повтору WebAuthn (новий доказ зі спожитим challenge vs ідемпотентна реєстрація за `enrollment_id`). **Редакція 2**: за рев'ю редакції 1 — підтвердження прив'язки контактів (M10), тест allowlist з урахуванням `session_web` (M9), спільний критерій WebAuthn і перший passkey (P2–P4), зв'язаний прохід відновлення passkey-only і конкурентні видалення (P2, P4, S2, X2), контракт шини й приймання staff (S3, S4, X2), M5 після M6, вимоги `ReauthDialog` (M12).

Джерело: [`passkeys-mfa-plan.md`](./passkeys-mfa-plan.md) (редакція 7: рішення Р1–Р17, матриця Р3,
рішення власника Д1–Д11). Чотири фічі (Д9), порядок `feat-245` → (`feat-246` ‖ `feat-247`) →
`feat-248`:

- `feat-245` **MFA Core**, гілка `feat/mfa-core`: M0–M14;
- `feat-246` **Passkeys**, гілка `feat/passkeys`, залежить від `feat-245`: P0–P6;
- `feat-247` **Staff MFA**, гілка `feat/staff-mfa`, залежить від `feat-245`: S0–S6;
- `feat-248` **Staff Passkey Mode**, гілка `feat/staff-passkey-mode`, залежить від `feat-246` і
  `feat-247`: X0–X3.

Базовий шлях: `packages/`, якщо не вказано інше. Коміт для посилань: `e664853`. Задача або
підзадача — один коміт або кілька дрібних і закінчується зеленим вузьким тестом свого рівня.
Посилання «Р4», «рядок 6 Р3» тощо — на розділи плану. Позначення тестів:

- `shared/test/*` — `pnpm --filter shared test`;
- `*.spec.ts` — `pnpm --filter backend test` або `pnpm --filter frontend test`;
- `*.pg.test.ts` — `make test-pg`;
- `*.redis.test.ts` — `make test-redis`;
- `frontend/e2e/` — `pnpm --filter frontend test:e2e` (мокований бекенд);
- `frontend/e2e-live/` — `pnpm --filter frontend test:e2e:live` (справжній бекенд, Chromium).

**Definition of Done (кожна фіча):** `make check`; `make test-pg` і `make test-redis` з кількістю
виконаних і пропущених тестів (або посилання на CI-джоби `test-pg`, `test-redis`); `test:e2e` і
`test:e2e:live`; `pnpm docs:build && pnpm docs:verify`; ручний прохід golden path. Усе це в
`feature-state/<feat-id>/progress.md` → Evidence of Completion. Повний `make check` — після
останньої правки, перед push.

**Незмінне:** вхід акаунта без MFA (відповіді, час, лист «новий вхід»), коди відповідей наявних
маршрутів, крім названих у задачах, `401` від `auth_guard` для анонімного запиту, канонічне тіло
`403`, поведінка адмінки до S5 (`MFA_REQUIRED_FOR_STAFF=false` до кінця S4).

**Інжектовані збої.** Тести Р4 вимагають точок інжекції: збій Redis на кроках 3.6 і активації,
відомий `ROLLBACK`, обрив підтвердження `COMMIT` (з'єднання рветься після відправлення `COMMIT`),
недоступність БД під час звірки, зупинка між переходом `activated` і надсиланням листа. Робляться
через залежності сервісу (`deps`), як у `user-event-bus`, без моків модулів.

---

## Реєстрація (до будь-якої фічі)

- [ ] Реєстраційний PR до `main` (гілка `chore/feat-245-248-register`): план, цей task list, записи
      `feat-245`…`feat-248` у `feature_list.json` (`not-started`, `owner`, `branch`,
      `dependencies`: `feat-246` і `feat-247` — `['feat-245']`, `feat-248` —
      `['feat-246', 'feat-247']`).

---

## feat-245 · MFA Core

### Порядок

| Задача | Залежить від   |
| ------ | -------------- |
| M1     | M0             |
| M2     | M1             |
| M3     | M1             |
| M4     | M1             |
| M6     | M3             |
| M5     | M2, M3, M4, M6 |
| M7     | M4             |
| M8     | M5, M6, M7     |
| M9     | M8             |
| M10    | M5, M9         |
| M11    | M5, M6         |
| M12    | M8–M11         |
| M13    | M12            |
| M14    | усі            |

M2, M3, M4 можна робити в будь-якому порядку після M1. **Enrollment (M5) відкривається для
користувача лише разом з M10** (рядки 6–8 і 16 Р3 у тому ж PR, межа фіч Р3): до M10 маршрути
`account/mfa/*` зареєстровано, але UI їх не показує, а e2e-live їх не викликає.

### M0 · Старт

- [ ] PR статусу (гілка `chore/feat-245-start`): `feat-245` → `in_progress`.
- [ ] Гілка `feat/mfa-core` від `main`, `feature-state/feat-245/progress.md` і порожній
      `session-handoff.md`.
- [ ] `./init.sh` зелений, результат у `progress.md`; червоний — зупинитися й зафіксувати.

### M1 · Спільні типи, політика, контракти (`shared`) — Р1–Р3, Р8, Р14

- [ ] `shared/src/auth/`: `AuthMethodRef`, `SessionAuthState` (Р2), `RecoveryState`.
- [ ] `shared/src/auth/proof-policy.ts`: дії й допустимі докази рядків 1–3, 5–8, 12, 16 Р3, вікна
      (значення з конфігу передаються параметром), `proofsFor(action, account, auth, now)` →
      `ok | { reason: 'reauth_required', proofs } | { reason: 'sign_in_again_required' }`.
- [ ] `shared/src/auth/staff-mfa-policy.ts`: `staffMfaPolicy('any')` — `enrolled`, `sessionOk`,
      `stepUpProofs` (Р10); режим `passkey` — заглушка, що кидає (з'являється в X1).
- [ ] `shared/src/auth/recovery-routes.ts`: константа маршрутів `allowInRecovery` (Р8 п. 1).
- [ ] Reasons у `shared/src/errors/`: `mfa_required`, `mfa_session_required`, `reauth_required`,
      `sign_in_again_required`, `invalid_code`, `mfa_ticket_invalid`, `mfa_ticket_used`,
      `mfa_attempt_expired`, `mfa_completion_pending`, `recovery_session`, `recovery_expired`,
      `recovery_contact_required`, `mfa_required_for_role`, `mfa_not_enrolled`.
- [ ] Аудит (`shared/src/audit/audit-actions.ts`): `auth.mfa.totp.enabled|disabled|replaced`,
      `auth.mfa.recovery_codes.regenerated`, `auth.mfa.recovery_code.used`; `AUDIT_PROOFS` +
      `password`, `totp`, `passkey`, `recovery_code`; група `sign-in`.
- [ ] Сповіщення (`shared/src/notifications/catalog.ts`, параметри): `mfa_enabled`,
      `mfa_disabled`, `recovery_code_used`, `recovery_codes_regenerated` (решта kinds Р9 — у
      P1/S2 разом з їхніми діями).
- [ ] Контракти й схеми (`shared/src/contracts/`, `schemas/auth/`): `auth/mfa/verify`,
      `auth/reauth/options`, `auth/reauth`, `auth/recovery/finish`, `account/mfa` (стан),
      `account/mfa/totp/setup|confirm`, `DELETE account/mfa/totp`,
      `account/mfa/recovery-codes` (перегенерація); відповідь `login` отримує варіант
      `{ status: 'mfa_required', methods }`; `main/init` — `wsToken: string | null`,
      `recovery?`.
- [ ] Тести `shared/test/`: таблиця матриці (кожна комбінація «MFA вимкнена/увімкнена × доказ ×
      свіжість × відновлення R/R+» для рядків M1, очікування записані явно); `staffMfaPolicy('any')`;
      схеми контрактів.

### M2 · Конфіг і `secret-box` — Р3, Р9

- [ ] `config/mfa.ts`: `MFA_ENCRYPTION_KEYS` (формат `<keyId>:<base64 32 bytes>[,…]`,
      обов'язковий у production-like, у dev — похідний від `APP_KEY` з попередженням),
      `AUTH_REAUTH_WINDOW_SECONDS` (300), `MFA_RECOVERY_WINDOW_SECONDS` (900),
      `MFA_TICKET_TTL_SECONDS` (300), `MFA_RESERVATION_TTL_SECONDS` (30); `validateRuntimeConfig`.
- [ ] `config/throttle-policies.ts`: `mfaVerifyUser` (10 / 15 хв, `AUTH_MFA_VERIFY_*`).
- [ ] `app/services/shared/secret-box.ts`: AES-256-GCM, AD = `user_id`, `keyId` у результаті,
      читання будь-яким ключем зі списку.
- [ ] `.env.example` з коментарями.
- [ ] Unit: шифр/дешифр; чужий ключ; ротація (старий `keyId` читається, пишеться поточним);
      чужий `user_id` в AD → помилка; конфіг: невірний формат, коротший ключ, production-like
      без ключа.

### M3 · Міграції й репозиторії — Р9

- [ ] `database/schema.ts`: `totp_factors` (`id`, `user_id UNIQUE`, `enrollment_id UNIQUE`,
      `secret_ciphertext`, `key_id`, `last_used_step`, `confirmed_at`, `created_at`),
      `mfa_recovery_codes` (`UNIQUE (user_id, code_hash)`, частковий індекс), `CHECK`
      `notifications.kind` з новими kinds; `relations.ts`.
- [ ] `db:generate` → міграції (Drizzle 1.0, папки).
- [ ] Репозиторії `totp-factor-repository.ts`, `recovery-code-repository.ts` з `executor`
      (`DbExecutor = db`): читання версії, умовне споживання кроку (за `id`, `user_id` і
      `last_used_step < $step`), вставка/заміна, умовне `used_at`, анулювання набору.
- [ ] `ALL_TOKEN_REPOSITORIES` / `claimLocked` поки не чіпати (M11).
- [ ] PG (`mfa-storage.pg.test.ts`): міграції на чисту БД; каскад при видаленні користувача;
      `UNIQUE` порушення; умовне споживання кроку — паралельні однакові кроки → один успіх;
      паралельні `used_at` → один успіх.

### M4 · Стан автентифікації сесії — Р2

- [ ] `vendor/types/types.d.ts`: `SessionData.auth?: SessionAuthState`; `SessionSignInMethod` + `'passkey'` (для P3).
- [ ] `redis-session-storage.ts`: `updateSessionAuth(sessionId, userToken, apply)` —
      compare-and-set з повторним читанням, застосовує функцію до поточного `auth`, інші ключі не
      чіпає. Мітки `verified` — максимум; `recovery` не відновлюється після зняття.
- [ ] `RequestSession.login(origin, auth)`: `auth` записується разом зі створенням сесії; вхід
      паролем/OAuth/реєстрація без MFA — `aal: 1`, `amr`, `verified.<метод> = now`.
- [ ] `renewSession` успадковує `auth` разом з `device`.
- [ ] Читання сесії без `auth` → `aal: 1`, без міток свіжості.
- [ ] `restore`: сесія з `recovery.expiresAt` у минулому → знищується, 401 `recovery_expired`.
- [ ] Архітектурний тест: `changeSessionData` не пише `auth`; запис `auth` лише через
      `updateSessionAuth` і вхід.
- [ ] Redis (`session-auth-state.redis.test.ts`): злиття конкурентних `updateSessionAuth`;
      `renewSession` зберігає `auth`; стара сесія без `auth`; прострочена сесія відновлення.

### M5 · TOTP — Р7

- [ ] `app/services/auth/mfa/totp.ts`: генерація секрету, `otpauth://` URI, код на крок, перевірка
      вікна ±1 → крок. Unit на векторах RFC 6238 (додаток B, SHA-1), межі вікна.
- [ ] `totpService.setup(context)`: рядки 1–2 Р3 (`requireProof`, M10 — до M10 тимчасово лише
      рядок 1 з P/O через ту саму політику), `hasRecoveryContact` (Р12) для першого фактора,
      `totpEnrollment` у даних сесії (`enrollmentId`, секрет, `expiresAt`).
- [ ] `totpService.confirm(enrollmentId, code)` — кроки 1–4 Р7: ідемпотентність за
      `enrollment_id`, **повторна перевірка `enrollment_id` під `lockById`** перед `DELETE`/`INSERT`,
      атомарна заміна, коди відновлення для першого фактора (M6), аудит
      (`enabled`/`replaced`), один CAS `updateSessionAuth` (зняти `totpEnrollment`, у сесії
      відновлення — `replacementFactor`).
- [ ] `totpService.verify(userId, code)` для Р4 і step-up: читання версії, перевірка її секретом,
      споживання кроку саме цієї версії.
- [ ] `totpService.disable` — рядок 3 Р3 і `signInCapability` (Р12; M10), останній фактор →
      коди анульовано, аудит `disabled`.
- [ ] PG (`totp-service.pg.test.ts`): два паралельні `confirm` з одним `enrollmentId` → одна
      версія, одна подія; повтор `confirm` після коміту й збою Redis → R+ для вже підтвердженої
      версії без повторної перевірки коду; `confirm` того самого `enrollmentId` після заміни не
      видаляє створену версію; заміна між перевіркою й `UPDATE` → `invalid_code`; код щойно
      підтвердженого кроку не проходить як другий фактор.

### M6 · Коди відновлення — Р8

- [ ] Генерація 10 кодів (80 біт, `xxxx-xxxx-xxxx-xxxx`), нормалізація введення, HMAC з
      `AUTH_OTP_HMAC_KEY`; `batch_id`.
- [ ] `recoveryCodeService.consume(userId, code, tx)` — умовний `used_at`, лічильник лишку.
- [ ] `recoveryCodeService.regenerate` — рядок 5 Р3 (F або R+), анулювання попереднього набору в
      тій самій транзакції, аудит.
- [ ] Unit: формат, нормалізація, ентропія; PG: паралельне споживання → один успіх; анулювання.

### M7 · Підготовка й активація сесії — Р4

- [ ] `RequestSession.prepareLogin(plan)`: запис `pending: true` + `completionId` під
      `plan.expectedUserToken`, поза індексом, TTL = залишок TTL квитка; без знищення попередньої
      сесії, cookie й `sessionListChanged`; ідемпотентно.
- [ ] Lua `activateLogin` (ключі квитка, запису й індексу з одним hash tag): актуальний стан
      квитка → `activated` (запис активний, індекс, квиток `activated { sessionId }`) /
      `already` (+ `sessionExists`) / `gone`; запис відтворюється з `plan` лише зі стану
      `completing`.
- [ ] `RequestSession.activateLogin(completionId)`: перевірка `expectedUserToken` у БД, Lua,
      потім лише для `activated` — витіснення анонімної сесії, `sessionListChanged`,
      `notifyNewSignIn`; cookie і CSRF-токен для `activated` і `already` з записом.
- [ ] `restore` відкидає записи `pending`; `listSessions` їх не бачить.
- [ ] Redis (`session-prepare-activate.redis.test.ts`): `pending` невидимий; дві паралельні
      активації → одна сесія, одне `activated`; пізній запит зі знімком `completing` після
      погашення квитка й `logout` → `gone`, запис не відтворено; `activated` без запису → 401;
      відтворення з `plan` зберігає `sessionId` і абсолютний `recovery.expiresAt`; cookie,
      `sessionListChanged`, `notifyNewSignIn` до активації не відбуваються.

### M8 · Другий крок входу — квиток — Р4

- [ ] `app/services/auth/mfa/mfa-ticket.ts`: Lua-скрипти станів квитка
      (`open` з `failures`, `reservations`, `settled` → `completing` з `completionId`, `xid`,
      `plan` → `activated` → видалено):
      резерв, облік результату (один раз на `reservationId`), захоплення з чинним резервом,
      повернення в `open`, видалення при `failures = 5`.
- [ ] Cookie `__Host-mfa` / `mfa` (dev), `browserBinding = HMAC(APP_KEY, anonSessionId)`;
      перевірка за підписаними claims анонімного cookie незалежно від позначки «витіснено».
- [ ] `completePrimaryAuth(user, origin)` у `buildAuthSuccess`, `finishSignIn` і
      `oauth-service.ts:619`: MFA увімкнена → квиток (`pendingOAuthLink` для `linkTrusted` і
      `link/confirm`, рядок 16), інакше `auth.login`. OAuth callback → `/login?mfa=required`.
- [ ] `POST /auth/mfa/verify` (`session_web`, `csrf_guard`): кроки 1–4 Р4 — throttle, транзакція
      (`lockById`, споживання TOTP/коду, `pg_current_xact_id`, захоплення, `pendingOAuthLink`
      лише для TOTP/passkey, `prepareLogin`, аудит, `COMMIT`), результат (підтверджено / відомий
      відкат / невідомий через `pg_xact_status`, `NULL` → невизначено), продовження в станах
      `completing` і `activated`.
- [ ] `session_web`: перший запит з новою сесією, що має `completionId`, видаляє квиток і cookie
      квитка.
- [ ] Архітектурний тест: `auth.login(` — лише `completePrimaryAuth`, `passkeyLogin` (P3),
      `renewSession`; `prepareLogin`/`activateLogin` — лише `completeMfa` і продовження.
- [ ] Redis + PG (`mfa-ticket.redis.test.ts`, `mfa-verify.pg.test.ts`) — **усі приймальні тести
      Р4** списком з плану, зокрема: п'ять конкурентних запитів і порядок результатів; запит із
      простроченим резервом → `mfa_attempt_expired`, споживання в PG відкочено; ротація
      `session_token` між комітом і першою активацією → 401 без сесії; таблиця втрат Redis
      (зник лише запис у `completing`; квиток `activated` без запису; втрачено весь Redis);
      обрив підтвердження `COMMIT` (`committed` / `aborted`); `NULL`; дві паралельні спроби
      продовження; лист щонайбільше один; OAuth-прив'язка не записана без другого кроку й при
      вході кодом.

### M9 · Сесія відновлення — Р8

- [ ] Гілка коду відновлення в M8: ротація `session_token`, `plan.expectedUserToken` — новий токен,
      `auth = { aal: 1, amr: [перший, 'recovery'], recovery: { startedAt, expiresAt } }`, TTL до
      `expiresAt` без ковзання; аудит, лист, сповіщення.
- [ ] Перевірка в `session_web` одразу після відновлення сесії: сесія з `recovery` → лише маршрути
      з `allowInRecovery` (позначка в `defineRoute`), інакше 403 `recovery_session`.
- [ ] `generateWsToken` відмовляє для сесії з `recovery`; `ws-session-auth.ts` відхиляє upgrade
      такої сесії; `main/init` — `wsToken: null`, `recovery: { expiresAt, replaced }`.
- [ ] R → R+ через `replacementFactor` (M5); видалення факторів і перегенерація кодів лише в R+;
      фактор з `id` з `replacementFactor` не видаляється в цій сесії.
- [ ] `POST /auth/recovery/finish` — знищує сесію.
- [ ] Тест реєстру маршрутів (`recovery-routes.spec.ts`) обходить **весь** HTTP-реєстр і для
      кожного маршруту визначає, чи є в його ланцюжку `session_web`:
    - з `session_web` і без `allowInRecovery` → для сесії відновлення 403 `recovery_session` до
      виконання обробника (зокрема `login`, `register`, скидання пароля, OAuth redirect/callback,
      `link/confirm`);
    - з `session_web` і з `allowInRecovery` → обробник виконується;
    - без `session_web` (`ping`, `ready` та інші публічні, `http-routes.ts:43`) → поведінка така
      сама, як без cookie: сесію вони не відновлюють і обмеження до них не застосовується;
    - кожен маршрут з позначкою `allowInRecovery` має `session_web` і є в матриці.
- [ ] PG + Redis: приймальний сценарій «єдиний TOTP + останній код» на рівні сервісів (e2e — M13).

### M10 · Step-up і чинні чутливі дії — Р3, Р12

- [ ] `requireProof(context, action)` поверх `proof-policy`; `POST /auth/reauth/options`,
      `POST /auth/reauth { proof }` → `updateSessionAuth` мітки методу; бюджети
      `changePasswordUser` і `mfaVerifyUser`.
- [ ] `signInCapability(lockedUser, tx)` (без passkeys; `hasRecoveryContact` з
      `AUTH_PHONE_ENABLED`); правило «до/після» для вимкнення TOTP і відв'язки OAuth (замінює
      перевірку `sign-in-methods-service.ts:143`).
- [ ] **Рядки 6–8 Р3:** зміна пароля, `link-phone/start`, `link-email/start`, відв'язка OAuth —
      `requireProof` замість `currentPassword` і правила 10 хв; поле `currentPassword` прибрати зі
      схем і контрактів (Д8, без зворотної сумісності); `requireCurrentPasswordReauth` і
      `RECENT_SIGN_IN_*` видаляються.
- [ ] **Рядок 7 — підтвердження прив'язки успадковує дозвіл зі `start`.** Свіжий доказ
      перевіряється на `start` (`link-phone/start`, `link-email/start`). `link-phone/confirm`
      (`auth-service.ts:774`, запис номера — під `lockById`, `:865`) і підтвердження листом
      прив'язки email повторно step-up не вимагають: SMS-код чи посилання — продовження вже
      дозволеної дії, а чинні перевірки сесії (`metadata.sessionId`, `presentedSessionToken`) лишаються.
      Щоб дозвіл не пережив зміну захисту акаунта, **будь-яка зміна стану MFA** (перше
      підключення, вимкнення, заміна TOTP, скидання адміністратором, а в `feat-246` — додавання й
      видалення passkey) у тій самій транзакції анулює незавершені прив'язки контактів
      (`sms_auth_challenges` з `flow = 'link_phone'`, `email_link_verifications`), як зміна пароля
      анулює посилання скидання (`retirePendingResets`). Спільна функція
      `retirePendingContactLinks(userId, tx)`.
- [ ] PG (`contact-link-step-up.pg.test.ts`): повний `start` → `confirm` для телефону й email зі
      свіжим доказом; `start` без свіжого доказу → `reauth_required`; **`start` → підключення TOTP
      → `confirm`** → посилання/код недійсні, номер не записано; `start` → вимкнення TOTP →
      `confirm` → так само; `confirm` після спливання вікна step-up, але без зміни MFA → успіх.
- [ ] Рядки 1–3, 5 Р3 для `account/mfa/*` підключаються до `requireProof`.
- [ ] Чинні тести цих маршрутів оновити (тіла запитів, нові reasons).
- [ ] PG/HTTP (`step-up.pg.test.ts`): кожен рядок 1–3, 5–8 — допустимий і недопустимий доказ,
      застаріла мітка, акаунт з MFA і паролем без фактора → `reauth_required` з `proofs` без
      `password`; OAuth-only без свіжого входу → `sign_in_again_required`; паралельні
      `reauth` не гублять мітки.

### M11 · Pre-hijack, аудит, листи, сповіщення — Р9, Р13, Р14

- [ ] `claimLocked` стирає TOTP і коди (passkeys — у P1); тест у `oauth-pre-hijack.pg.test.ts`.
- [ ] Листи: `mfa-notice.ts` (увімкнено, вимкнено, замінено, коди перегенеровано, код
      використано); лист скидання пароля пояснює, що MFA лишається; лист «новий вхід» називає
      метод (`пароль + TOTP`). Snapshot-тести в `__snapshots__/`.
- [ ] `userNotificationService.security` для нових kinds; push-тексти.
- [ ] Unit/PG: кожна дія пише подію з доказом (`withProof`) і надсилає сповіщення.

### M12 · Frontend — Р15

- [ ] `utils/api.ts`: `authApi.mfaVerify`, `reauth*`, `recoveryFinish`; `accountApi.mfa*`.
- [ ] `components/auth/MfaChallengeForm.vue` (застосунок, код відновлення, «немає доступу»),
      `LoginForm.vue` і `Login.vue` (`?mfa=required`), автоматичне продовження при
      `mfa_completion_pending`.
- [ ] `components/account/ReauthDialog.vue` + `withReauth(call)` в `utils/api-client.ts`:
    - на 403 `reauth_required` діалог показує **лише** докази з `proofs` відповіді (без поля
      пароля, якщо `password` немає в списку);
    - після успішного `reauth` повторює вихідний запит **один** раз;
    - `sign_in_again_required` і `mfa_session_required` ведуть на вхід із поверненням
      (`/login?redirect=<поточний шлях>`, `safeRedirectTarget`), без діалогу;
    - прибрати inline-поля поточного пароля з `UserAccount.vue` (пароль, контакти, відв'язка).
    - Unit і e2e mock: набір полів для кожного варіанта `proofs`; повернення після входу.
- [ ] Секція «Безпека входу» (`data-testid="mfa-settings"`): майстер TOTP (QR — `qrcode`
      лінивим імпортом), коди (показ один раз, копіювання, `.txt`), лишок кодів.
- [ ] Режим відновлення: `main/init.recovery` → майстер «новий фактор → прибрати втрачений → нові
      коди → завершити», без WebSocket.
- [ ] i18n `en/uk/pl`, тексти reasons.
- [ ] `check-bundle-graph` (ADR 0005) зелений.
- [ ] e2e mock (`frontend/e2e/mock/mfa.spec.ts`): другий крок, продовження, ReauthDialog,
      майстер TOTP, коди, режим відновлення.
- [ ] api-playground: кроки `mfa/verify`, `reauth`.

### M13 · e2e-live — Р16

- [ ] `frontend/e2e-live/mfa.spec.ts` (TOTP рахує тест з секрету майстра):
    - підключення TOTP → вихід → вхід паролем + TOTP;
    - зміна пароля з ReauthDialog (TOTP);
    - **приймальний сценарій Р8:** єдиний TOTP, останній код відновлення → режим відновлення
      (адмінка й WS недоступні) → заміна TOTP → нові коди → завершити → вхід новим TOTP.

### M14 · Документація, перевірка, закриття — Р17

- [ ] `documentation/backend/mfa.md` і `en/backend/mfa.md`: матриця Р3, стан сесії, квиток і
      таблиця втрат Redis (порада AOF), відновлення, конфіг; сайдбар обох локалей, `KEY_PAGES`,
      `EN_KEY_PAGES`.
- [ ] Оновити `backend/auth.md`, `account.md`, `security.md`, `configuration.md`,
      `audit-log.md`, `notifications.md`, `database.md`;
      `docs/requirements/security/template-session-token-lifecycle.md`.
- [ ] DoD з лічильниками; ручний golden path; PR `feat/mfa-core` → `main`; PR статусу `review`;
      після мерджу — «Mark feat-245 done».

---

## feat-246 · Passkeys

Починається, коли `feat-245` у статусі `done`. Може йти паралельно з `feat-247`.

### P0 · Старт

- [ ] PR статусу: `feat-246` → `in_progress`; гілка `feat/passkeys`, `feature-state/feat-246/`;
      `./init.sh` зелений.

### P1 · Залежності, конфіг, сховище — Р6, Р9

- [ ] `@simplewebauthn/server` (backend) і `@simplewebauthn/browser` (frontend), точні версії.
- [ ] `config/webauthn.ts`: `WEBAUTHN_RP_ID` (явний у production-like), `WEBAUTHN_RP_NAME`,
      `WEBAUTHN_ORIGINS` (точний список, `https://` у production-like); `.env.example`.
- [ ] Міграція `webauthn_credentials` (з `enrollment_id UNIQUE`) і `users.webauthn_user_handle`;
      kinds `passkey_added`, `passkey_removed`; аудит `auth.passkey.added|removed|counter_regressed`.
- [ ] `claimLocked` стирає passkeys і `webauthn_user_handle`; `signInCapability` рахує passkeys.
- [ ] PG: каскад, `UNIQUE (credential_id)`, `claimLocked`.

**Спільний критерій приймання WebAuthn (P2–P4)** — однаковий для **реєстрації, входу без пароля,
другого фактора й step-up**, перевіряється таблицею тестів по чотирьох сценаріях
(`webauthn-ceremony.spec.ts` + Redis/PG для споживання):

| Вимога (Р5, Р6)                                                                  | Реєстрація  | Без пароля | Другий фактор | Step-up   |
| -------------------------------------------------------------------------------- | ----------- | ---------- | ------------- | --------- |
| `requireUserVerification: true`; відповідь без UV → відмова                      | ✓           | ✓          | ✓             | ✓         |
| точний `expectedOrigin` зі списку; інший origin → відмова                        | ✓           | ✓          | ✓             | ✓         |
| точний `expectedRPID`; інший RP ID → відмова                                     | ✓           | ✓          | ✓             | ✓         |
| challenge свого призначення й прив'язки; чужого призначення → відмова            | `register:` | `login`    | `mfa:`        | `reauth:` |
| challenge споживається атомарно; новий доказ із уже спожитим challenge → відмова | ✓           | ✓          | ✓             | ✓         |
| ключ належить очікуваному користувачу / `userHandle` власника                    | —           | ✓          | ✓             | ✓         |
| лічильник: `0` допустимий, інакше монотонний, регрес → відмова й подія           | —           | ✓          | ✓             | ✓         |

Перевірку виконує одна функція `verifyWebAuthnCeremony(purpose, …)` з цими параметрами; сценарії
не викликають бібліотеку напряму (архітектурний тест).

**Повтор — два різні випадки, два різні очікування:**

- **Повторне використання challenge для нового підтвердження** (інша відповідь автентифікатора,
  інший ключ, інша сесія) → відмова в усіх чотирьох сценаріях: challenge одноразовий.
- **Повтор тієї самої операції реєстрації за `enrollment_id`** (той самий запит після коміту, коли
  відповідь чи запис стану сесії загубились, P2) → ключ з цим `enrollment_id` уже закомічено, тож
  `verifyWebAuthnCeremony` **не викликається**: сервер лише завершує вже підтверджену реєстрацію
  (знімає challenge, у сесії відновлення записує R+) і повертає той самий ключ; другий ключ не
  створюється. Повтор з тим самим `enrollmentId`, але **іншою** відповіддю автентифікатора (інший
  `credential_id`) → відмова, бо операція вже завершена іншим ключем. Для входу без пароля,
  другого фактора й step-up ідемпотентного повтору за `enrollment_id` немає: їхні повтори
  обслуговує квиток Р4 (продовження) або новий challenge.

### P2 · Реєстрація й керування — Р6, Р12

- [ ] `POST /account/passkeys/options` (challenge `register:<sessionId>` і `enrollmentId` у даних
      сесії), `POST /account/passkeys` (ідемпотентно за `enrollment_id`, R+ у відновленні), список,
      перейменування, `DELETE` (рядок 3 Р3, `signInCapability`, фактор з `replacementFactor` не
      видаляється); до 20 ключів.
- [ ] **Passkey як перший фактор** (рядок 1 Р3): `options` і реєстрація вимагають
      `hasRecoveryContact` (Р12) → інакше 409 `recovery_contact_required`; перший passkey генерує
      коди відновлення (показ один раз), як перший TOTP.
- [ ] Додавання й видалення passkey викликає `retirePendingContactLinks` (M10).
- [ ] PG: паралельні реєстрації з одним `enrollmentId` → один ключ; повтор того самого запиту
      після коміту й збою Redis → R+, ключ той самий, другого немає; той самий `enrollmentId` з
      іншим `credential_id` → відмова; спожитий challenge з новою відповіддю → відмова; перший passkey без підтвердженого контакту → 409; видалення останнього способу
      входу → 409; лише passkeys без контакту → 409; **два конкурентні видалення двох останніх
      passkeys акаунта без пароля й OAuth → одне успішне, друге 409 `last_sign_in_method`**
      (`lockById`, Р16).

### P3 · Вхід без пароля — Р6

- [ ] `POST /auth/passkey/options` (Redis `auth:webauthn:login:<id>`, TTL 5 хв),
      `POST /auth/passkey/verify` (`GETDEL`, `userHandle` власника, UV, точні origin і RP ID,
      монотонний лічильник, `signCount = 0`), `passkeyLogin` → `auth.login` з `aal: 2`,
      `amr: ['webauthn']`, метод `passkey`.
- [ ] Unit/Redis: рядки спільного критерію для входу без пароля; невідомий ключ і невдалий підпис
      — однакова 401.

### P4 · Passkey як другий фактор і step-up — Р4, Р6, Р7

- [ ] `mfa/verify` з `method: 'webauthn'`: challenge `mfa:<hash(ticketId)>`, `allowCredentials`
      користувача квитка, ключ належить цьому користувачу; споживання — оновлення лічильника в
      транзакції Р4.
- [ ] `reauth` з `proof: 'webauthn'`: challenge `reauth:<sessionId>`, мітка `verified.webauthn`.
- [ ] Recovery: заміна фактора passkey (R → R+), видалення втраченого passkey в R+.
- [ ] Тести: рядки спільного критерію для другого фактора й step-up; приймальні тести Р4 для
      методу `webauthn` (захоплення, відкат повертає лічильник).
- [ ] **Відновлення акаунта лише з passkey — зв'язаний прохід Р12** (PG + Redis,
      `passkey-only-recovery.pg.test.ts`; фікстура: підтверджена пошта, лише passkey, коди):
    1.  «Забули пароль» → пароль встановлено; passkey, коди й MFA збережено (не claim);
    2.  вхід паролем → `mfa_required`, методи без пароля;
    3.  **гілка A — код відновлення:** сесія відновлення → новий passkey (R+) → видалення
        втраченого (`canSignIn` тримається на паролі) → нові коди → `recovery/finish` → вхід
        паролем і новим passkey;
    4.  **гілка B — без кодів** (адміністративне скидання) потребує S2 з `feat-247`, тож для
        passkey-only акаунта вона закріплена **лише за X2** (`feat-248`), коли обидві фічі злиті.
        `feat-246` перевіряє кроки 1–3.

### P5 · Frontend і e2e-live — Р15, Р16

- [ ] «Увійти з passkey», conditional UI (`autocomplete="username webauthn"`), passkey у
      `MfaChallengeForm` і `ReauthDialog`, список ключів у «Безпеці входу»; лінивий імпорт
      `@simplewebauthn/browser`; i18n.
- [ ] e2e mock; e2e-live з віртуальним автентифікатором (CDP `WebAuthn.addVirtualAuthenticator`):
      реєстрація, вхід без пароля, другий фактор після пароля, step-up, відновлення з заміною
      passkey.

### P6 · Документація, закриття

- [ ] `mfa.md` (обидві локалі): passkeys, `rpId` і чому його не можна міняти; `configuration.md`.
- [ ] DoD; PR; статус `review`; «Mark feat-246 done».

---

## feat-247 · Staff MFA

Починається, коли `feat-245` у статусі `done`. Може йти паралельно з `feat-246`. До S5 вимога
вимкнена (`MFA_REQUIRED_FOR_STAFF=false`), поведінка адмінки не змінюється.

### S0 · Старт

- [ ] PR статусу: `feat-247` → `in_progress`; гілка `feat/staff-mfa`, `feature-state/feat-247/`;
      `./init.sh` зелений.

### S1 · Step-up для зміни ролі — рядок 9 Р3

- [ ] `roleAssignmentService.assign` (HTTP): `requireProof` виконавця (F з `stepUpProofs`); CLI
      без змін.
- [ ] `RoleChangeDialog` через `withReauth`.
- [ ] PG/HTTP: без свіжого фактора → `reauth_required`; з ним — успіх.

### S2 · Скидання MFA адміністратором і CLI — Р12, Р13

- [ ] Дозвіл `users.mfa.reset` (лише `admin`) у `shared/access`; kind `mfa_reset`; аудит
      `auth.mfa.reset` (`admin` / `cli`, причина, доказ виконавця).
- [ ] `POST /admin/users/:id/mfa/reset { reason }`: `can:users.mfa.reset`, `requireProof` (рядок
      10), під `lockById` — `signInCapability` **без винятків для `canSignIn`**, видалення факторів
      і кодів, ротація `session_token`; собі — заборонено.
- [ ] CLI `user:mfa-reset <email> --reason` (за зразком `user:set-role`), ті самі правила.
- [ ] Діалог в `AdminUsersView` з поясненням 409 `last_sign_in_method`.
- [ ] Скидання викликає `retirePendingContactLinks` (M10).
- [ ] PG (самостійний, без passkeys — `feat-247` не залежить від `feat-246`): акаунт з паролем і
      TOTP без кодів → скидання адміністратором успішне, TOTP і коди видалено, `session_token`
      ротовано, сесії й сокети закрито → вхід паролем без другого кроку → підключення нового
      фактора; скидання самому собі → 403; тест справжнього CLI-процесу з тими самими
      очікуваннями. Правило `canSignIn` під скиданням перевіряється unit-тестом
      `signInCapability` (стан «до/після» без способу входу → 409); **повний passkey-only сценарій
      з 409 до встановлення пароля — лише в X2**.

### S3 · Політика на HTTP і WS — Р10, Р11 (вимога вимкнена)

- [ ] `config/mfa.ts`: `MFA_REQUIRED_FOR_STAFF` (поки типово `false`), `MFA_STAFF_FACTOR` (лише
      `any`), `MFA_STAFF_FACTOR_MAX_AGE_HOURS` (12).
- [ ] `permissionGuard`: staff-роль при ввімкненій вимозі → `sessionOk`, reasons `mfa_required` /
      `mfa_session_required`.
- [ ] `ws-session-auth.ts`: `auth` у `UserConnection`; `wsPermissionGuard` і `ws-role-sync` через
      `sessionOk`.
- [ ] `adminWsChannelService`: підписники, впорядковані за `staffAccessDeadline`;
      `broadcastMessageToChannel('admin')` синхронно відписує прострочені перед `publish`;
      архітектурний тест — `publish` в `admin` лише через неї.
- [ ] Таймер дедлайну → відписка, `mfaStale`, `access_changed { reason: 'mfa_session_required' }`;
      оновлення при зміні `auth`, зняття при закритті.
- [ ] Step-up → оновлення `auth` з'єднань того самого `sessionId` на цьому інстансі.
- [ ] **Зміна контракту серверної шини.** Чинний `ServerEventHandler` — `(event, userId)`
      (`user-event-bus.ts:40`), без даних. Додати до серверних подій необов'язковий payload:
      `ServerEventHandler = (event, userId, payload?) => void`, конверт шини переносить його;
      `session_auth_changed` — новий `SERVER_BUS_EVENTS` з `payload: { sessionId }` (схема
      перевіряється при отриманні, інший вміст → подія ігнорується з логом). Чинні серверні події
      (`user_role_changed`) працюють без payload, як зараз.
- [ ] Обробник `session_auth_changed` на інших інстансах: перечитати сесію `sessionId` з Redis,
      оновити `auth` і дедлайн своїх з'єднань цієї сесії, надіслати `admin_channel_ready`.
- [ ] Redis (`user-event-bus.redis.test.ts`): payload доходить до другого інстансу; подія без
      payload (стара форма) і з невалідним payload; **два інстанси** — step-up на першому оновлює
      `auth` з'єднання на другому.
- [ ] Тест: усі споживачі імпортують `staffMfaPolicy`.

### S4 · Матриці й перевірки перед увімкненням — Р11, Р16

- [ ] HTTP-матриця `can:` і WS-матриця `ws_can:` для staff-сесій AAL1 / AAL2 / відновлення /
      застарілої мітки (вимога ввімкнена в тесті).
- [ ] Доставка: фіктивний годинник за дедлайном, callback таймера не виконано, публікація →
      подія не доходить до простроченого сокета й доходить до інших; окремо — відмова `ws_can:`.
- [ ] Скидання MFA → підписаний клієнт більше не отримує подій (сокет закрито).
- [ ] **Step-up переносить дедлайн і повертає підписку:** сокет відписано за дедлайном → step-up
      фактором у тій самій сесії → `auth` з'єднання оновлено, новий дедлайн, `admin_channel_ready`
      → клієнт підписується → наступна публікація доходить; те саме між двома інстансами (через
      `session_auth_changed`).
- [ ] **Реакція клієнта на `access_changed { reason: 'mfa_session_required' }`** (unit frontend +
      e2e mock): відкрита адмінка закривається так само, як при пониженні ролі у `feat-240`
      (перехід на вхід із поверненням), повторна підписка не надсилається; після нового входу з
      фактором адмінка відкривається.
- [ ] e2e-live: відкрита адмін-вкладка після скидання MFA іншим адміністратором закривається.
- [ ] Ручна перевірка (evidence): CLI-відновлення останнього адміністратора.

### S5 · Увімкнення — Р10

- [ ] Видача staff-ролі (HTTP і CLI) лише `enrolled`-акаунту: 409 `mfa_not_enrolled`; чинні
      фікстури staff-акаунтів отримують TOTP.
- [ ] `MFA_REQUIRED_FOR_STAFF` типово `true`; `db:seed` для демо-адміна підключає TOTP з відомим
      секретом (dev) і друкує його.
- [ ] Frontend: `adminRedirect` → `/account?section=security` з поясненням; банер staff без MFA.
- [ ] e2e-live `roles.spec.ts` і адмінські специфікації: вхід адміністратора з TOTP.

### S6 · Документація, закриття

- [ ] `mfa.md`, `reference/roles-capabilities.md` (MFA для персоналу, `users.mfa.reset`),
      `configuration.md`; перехідний ризик staff без MFA.
- [ ] DoD; PR; статус `review`; «Mark feat-247 done».

---

## feat-248 · Staff Passkey Mode

Починається, коли `feat-246` і `feat-247` у статусі `done`.

### X0 · Старт

- [ ] PR статусу: `feat-248` → `in_progress`; гілка `feat/staff-passkey-mode`,
      `feature-state/feat-248/`; `./init.sh` зелений.

### X1 · Режим `passkey` — Р10, Д11

- [ ] `staffMfaPolicy('passkey')`: `enrolled` — хоча б один passkey; `sessionOk` —
      `webauthn ∈ amr` і свіжа `verified.webauthn`; `stepUpProofs` — лише passkey.
- [ ] `MFA_STAFF_FACTOR=passkey` у конфігу; `validateRuntimeConfig` відмовляє без налаштованого
      WebAuthn.
- [ ] Unit: вхід TOTP + step-up passkey → не `sessionOk`; таблиця обох режимів.

### X2 · Застосування й тести

- [ ] Видача ролі, `signInCapability`, `can:`, `ws_can:`, `ws-role-sync`, рядки 9–10 — у режимі
      `passkey` (через ту саму політику, без нових гілок у споживачах).
- [ ] Банер для staff без passkey перед перемиканням.
- [ ] HTTP/WS-матриці в обох режимах; e2e-live: адміністратор з passkey (віртуальний
      автентифікатор) входить в адмінку, з TOTP — `mfa_session_required`.
- [ ] **Видача staff-ролі в обох режимах** (PG/HTTP і CLI): `any` — акаунт лише з TOTP отримує
      роль; `passkey` — той самий акаунт → 409 `mfa_not_enrolled`, з passkey → успіх.
- [ ] **Видалення факторів staff-акаунта в обох режимах** (PG): `any` — видалити passkey, коли
      лишається TOTP, можна, видалити останній фактор → 409 `mfa_required_for_role`; `passkey` —
      вимкнути TOTP можна, видалити останній passkey → 409 `mfa_required_for_role`, навіть якщо TOTP
      лишається; скидання адміністратором — виняток в обох режимах.
- [ ] **Гілка B зв'язаного проходу Р12 для passkey-only акаунта** (PG + Redis, фікстура P4:
      підтверджена пошта, лише passkey, без кодів) — єдине місце цього сценарію:
      адміністративне скидання до встановлення пароля → 409 `last_sign_in_method`, UI адмінки
      пояснює причину → «Забули пароль» (MFA збережено) → вхід паролем просить другий фактор →
      скидання → успіх, сесії закрито → вхід паролем без другого кроку → підключення нового
      фактора. Те саме через CLI `user:mfa-reset`.

### X3 · Документація, закриття

- [ ] Документація розгортання: рекомендація `passkey`, порядок перемикання.
- [ ] Рекомендації (`future/template-functionality-recommendations.md`): пункт 7 —
      «реалізовано `feat-245`…`feat-248`».
- [ ] DoD; PR; статус `review`; «Mark feat-248 done».
