# Двоетапний вхід (MFA)

Акаунт може мати другий фактор: застосунок-автентифікатор (TOTP), passkeys (WebAuthn) і одноразові коди відновлення. Passkey ще й входить сам, без пароля. Після пароля або входу через соцмережу такий акаунт отримує не сесію, а квиток другого кроку; сесію створює лише правильний код. Чутливі дії (зміна пароля, прив'язка контактів, відв'язка способу входу, керування факторами) підтверджуються повторно (step-up) за однією матрицею. Код відновлення відкриває обмежену сесію відновлення, у якій можна лише замінити фактор.

План і рішення: [`docs/plan/passkeys-mfa-plan.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/passkeys-mfa-plan.md). Джерела: спільна політика [`shared/src/mfa`](https://github.com/Blazheiko/vibe-template/tree/main/packages/shared/src/mfa), сервіси [`services/auth/mfa`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/services/auth/mfa), контракти [`contracts/mfa.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/mfa.ts), [`contracts/passkeys.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/passkeys.ts) і [`contracts/auth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/auth.ts).

## Маршрути

| Маршрут                                  | Middleware                                | Що робить                                                                                                                         |
| ---------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/mfa/verify`              | `session_web`, `csrf_guard`               | другий крок входу: `{ method: 'totp' \| 'recovery_code', code }`, `{ method: 'webauthn', response }` або `{ method: 'continue' }` |
| `POST /api/auth/mfa/state`               | `session_web`, `csrf_guard`               | чи тримає цей браузер другий крок: `{ status: 'mfa_required', methods, completing? }` або `{ status: 'none' }`                    |
| `POST /api/auth/mfa/webauthn/options`    | `session_web`, `csrf_guard`               | параметри підпису passkey для квитка другого кроку                                                                                |
| `POST /api/auth/passkey/options`         | `session_web`, `csrf_guard`               | параметри входу лише passkey і `challengeId`                                                                                      |
| `POST /api/auth/passkey/verify`          | `session_web`, `csrf_guard`               | вхід лише passkey: `{ challengeId, response }`                                                                                    |
| `POST /api/auth/reauth/options`          | `session_web`, `csrf_guard`, `auth_guard` | докази step-up, які цей акаунт може дати                                                                                          |
| `POST /api/auth/reauth`                  | `session_web`, `csrf_guard`, `auth_guard` | step-up: `{ proof: 'password', password }`, `{ proof: 'totp', code }` або `{ proof: 'webauthn', response }`                       |
| `POST /api/auth/reauth/webauthn/options` | `session_web`, `csrf_guard`, `auth_guard` | параметри step-up через passkey (challenge у даних цієї сесії)                                                                    |
| `POST /api/auth/recovery/finish`         | `session_web`, `csrf_guard`, `auth_guard` | завершує сесію відновлення                                                                                                        |
| `GET /api/account/mfa`                   | `session_web`, `csrf_guard`, `auth_guard` | стан факторів, лишок кодів, чи є контакт для відновлення                                                                          |
| `POST /api/account/mfa/totp/setup`       | те саме                                   | новий секрет (у даних цієї сесії, 10 хв) і `otpauth://` URI                                                                       |
| `POST /api/account/mfa/totp/confirm`     | те саме                                   | підтверджує код і записує фактор; замінює попередній застосунок                                                                   |
| `DELETE /api/account/mfa/totp`           | те саме                                   | вимикає TOTP; останній фактор забирає й коди відновлення                                                                          |
| `POST /api/account/mfa/recovery-codes`   | те саме                                   | новий набір кодів; попередній перестає діяти                                                                                      |
| `GET /api/account/passkeys`              | те саме                                   | passkeys акаунта (назва, тип, синхронізований, створено, останнє використання)                                                    |
| `POST /api/account/passkeys/options`     | те саме                                   | параметри нового passkey і `enrollmentId` (challenge у даних цієї сесії)                                                          |
| `POST /api/account/passkeys`             | те саме                                   | зберігає новий passkey; ідемпотентно за `enrollmentId`                                                                            |
| `PATCH /api/account/passkeys/:id`        | те саме                                   | перейменовує passkey                                                                                                              |
| `DELETE /api/account/passkeys/:id`       | те саме                                   | видаляє passkey; останній спосіб входу лишається                                                                                  |

QR-код малює браузер (`qrcode`), секрет не йде до сторонніх сервісів.

## Другий крок входу

`POST /api/auth/login` (і OAuth callback) для акаунта з фактором відповідає `{ status: 'mfa_required', methods }` (passkey першим, якщо він є) і ставить cookie квитка `__Host-mfa` (`mfa` без HTTPS): `HttpOnly`, `SameSite=Strict`, 5 хв. OAuth редиректить на `OAUTH_FRONTEND_MFA_URL` (типово `/login?mfa=required`) з методами акаунта: `&methods=webauthn,totp,recovery_code`. Квиток прив'язаний до сесійного cookie браузера, тож вкрадений квиток в іншому браузері нічого не відкриває.

- П'ять неправильних кодів закривають квиток. Ліміт рахує підтверджені невдачі, а не запити: збій інфраструктури повертає спробу.
- Код TOTP витрачається для конкретної версії фактора (`last_used_step`), тож повтор того самого коду відхиляється.
- Сесія створюється тим самим запитом, що захопив квиток: спершу як `pending` до коміту, потім одним переходом у Redis. Повтор того самого запиту (втрачена відповідь, 503 `mfa_completion_pending`) завершує вже підтверджений вхід тією самою сесією; невідомий результат `COMMIT` звіряється через `pg_xact_status`.
- Спроба тримає резервування квитка (`MFA_RESERVATION_TTL_SECONDS`), яке перевіряється за годинником самого захоплення: перевірка фактора чи блокування рядка, що тривали довше, відкочують доказ і відповідають 401 `mfa_attempt_expired` (крок TOTP, код відновлення й лічильник passkey не витрачаються). Поки підтверджена спроба завершується, `POST /auth/mfa/webauthn/options` теж відповідає 503 `mfa_completion_pending`: браузер повторює той самий запит verify, а не нову церемонію. Відповідь passkey, чий challenge зник або витрачений (його забрала спроба, що відкотилася), — не хибний доказ: 401 `mfa_attempt_expired` без зарахування невдачі, і браузер запускає нову церемонію.
- `{ method: 'continue' }` не несе доказу: він лише завершує вхід, який квиток цього браузера вже підтвердив (квиток у стані `completing` або `activated`, cookie квитка і прив'язка до сесії браузера), коли відповідь втрачено або сторінку перезавантажено і форма не має запиту для повтору. Форма шле його, коли `POST /auth/mfa/webauthn/options` відповідає `mfa_completion_pending`, з тими самими паузами. `activated` активується тією самою сесією; `completing` звіряється через `pg_xact_status`: закомічено — вхід, відкочено — квиток знову `open` і 401 `mfa_attempt_expired` (браузер дає новий доказ), невідомо — 503 `mfa_completion_pending`. Для квитка `open` `continue` нічого не доводить: 401 `mfa_attempt_expired` без резервування і без зарахування невдачі. Квиток іншого браузера — 401 `mfa_ticket_invalid`. Запит обмежує ліміт маршруту, як і решту запитів verify; бюджет кодів користувача (`AUTH_MFA_VERIFY_MAX_ATTEMPTS_PER_USER`) він не витрачає, як і повтор підтвердженого запиту, бо доказ не перевіряється. Поки вхід завершується, форма ховає перемикачі на інші фактори.
- Другий крок входу паролем форма тримає лише в пам'яті. Після перезавантаження сторінка входу перед новим входом питає `POST /api/auth/mfa/state`: для квитка цього браузера (cookie квитка і прив'язка, як їх перевіряє `continue`) відповідь — `{ status: 'mfa_required', methods }` з методами акаунта, як при вході, і `completing: true`, коли спробу вже підтверджено; тоді сторінка знову показує другий крок, а для `completing` форма одразу шле `continue`. Без cookie, для простроченого квитка, квитка іншого браузера чи акаунта, що лишився без факторів, — `{ status: 'none' }` і нічого більше. Запит нічого не резервує, не рахує й не змінює.
- Успішна відповідь `POST /auth/mfa/verify` (будь-який метод, зокрема `continue`) несе `recovery: { expiresAt, replaced }`, коли створена сесія — сесія відновлення (той самий стан, що дає `main/init`), і нічого для звичайного входу. Клієнт зберігає його до відкриття сторінки акаунта, тож та сторінка ніколи не питає маршрутів, заборонених сесії відновлення.
- Прив'язка нової соцмережі до акаунта з MFA записується лише після другого кроку TOTP; при вході кодом відновлення — не записується.

**Що гарантовано для останнього коду відновлення.** Квиток живе в Redis. Збій активації, тимчасова недоступність Redis і загублена відповідь код не втрачають. Повна втрата Redis разом із квитком (або недоступність БД чи Redis усі 5 хв квитка) після коміту залишає код спожитим без сесії — тоді допомагає адміністратор. Тому Redis у продакшені має бути з персистентністю (AOF).

## Passkeys

Бібліотека [`@simplewebauthn`](https://simplewebauthn.dev/) (`server` на бекенді, `browser` на фронтенді, точні версії). Кожну відповідь браузера перевіряє одна функція [`verifyWebAuthnCeremony`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/mfa/webauthn-ceremony.ts) — однаково для реєстрації, входу без пароля, другого кроку й step-up (архітектурний тест не дає викликати бібліотеку деінде):

- обов'язкова верифікація користувача (UV): відбиток, обличчя або PIN пристрою;
- точний `origin` зі списку `WEBAUTHN_ORIGINS` і точний `WEBAUTHN_RP_ID`;
- challenge свого призначення й прив'язки: `register:<sessionId>`, `login`, `mfa:<hash квитка>`, `reauth:<sessionId>`; одноразовий (`GETDEL` у Redis або атомарне споживання з даних сесії);
- ключ належить очікуваному користувачу; при вході без пароля `userHandle` відповіді дорівнює випадковому `users.webauthn_user_handle` власника (не id і не email);
- лічильник підписів: `0` з обох боків допустимий (синхронізовані passkeys), інакше лише росте (умовний `UPDATE`). Регрес — відмова й подія `auth.passkey.counter_regressed`; ключ лишається, вирішує власник.

**Реєстрація.** `POST /account/passkeys/options` (рядки 1–2 матриці; перший фактор вимагає підтвердженого контакту, 409 `recovery_contact_required`) кладе challenge і `enrollmentId` у дані сесії. `POST /account/passkeys` перевіряє відповідь і записує ключ; повтор після коміту повертає той самий ключ, а інший ключ для завершеної реєстрації — 409 `enrollment_used`. Перший passkey видає коди відновлення. До 20 ключів (409 `passkey_limit`), атестація `none`, `residentKey: required`. Видалення (рядок 3) під блокуванням рядка користувача не залишає акаунт без способу входу (409 `last_sign_in_method`).

**Вхід лише passkey** — повноцінний вхід рівня 2 (`amr: ['webauthn']`), без другого кроку. Невідомий ключ, хибний підпис і чужий `userHandle` дають однакову 401. Сторінка входу пропонує passkey і в автозаповненні поля логіна (conditional UI, `autocomplete="username webauthn"`).

::: warning RP ID не змінюють
Passkey назавжди прив'язаний до свого RP ID. Зміна `WEBAUTHN_RP_ID` після запуску робить недійсними всі зареєстровані passkeys (лишаються пароль, TOTP і коди). Тому в production-like змінна обов'язкова явно, а не виводиться з URL.
:::

## Повторне підтвердження (step-up)

Сесія зберігає `auth`: рівень входу (`aal` 1 або 2, ніколи не зростає), методи входу (`amr`) і час останнього доказу кожного методу. Дія з матриці питає, чи свіжий потрібний доказ (вікно `AUTH_REAUTH_WINDOW_SECONDS`, типово 300 с), і відповідає `403 { reason: 'reauth_required', details: { kind: 'reauth_required', proofs } }`; клієнт показує діалог лише з цими доказами й повторює запит.

| Дія                                         | Без MFA                                                     | З MFA                   |
| ------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| Підключити перший фактор                    | свіжий пароль (або вхід через соцмережу ≤ 10 хв без пароля) | —                       |
| Додати / замінити фактор                    | —                                                           | свіжий TOTP або passkey |
| Вимкнути фактор, нові коди                  | —                                                           | свіжий TOTP або passkey |
| Змінити пароль, прив'язати телефон чи email | свіжий пароль (або недавній вхід через соцмережу)           | свіжий TOTP або passkey |
| Відв'язати соцмережу                        | те саме                                                     | свіжий TOTP або passkey |
| Завершити інші сесії                        | лише сесія                                                  | лише сесія              |

Для акаунта з MFA пароль сам нічого не підтверджує. Прив'язка телефону чи email підтверджується на старті; SMS-код чи посилання завершують її без нового step-up, але будь-яка зміна стану MFA анулює незавершені прив'язки.

Перший фактор вимагає підтвердженої пошти (або телефону при `AUTH_PHONE_ENABLED`): через неї користувач знову встановлює пароль, якщо втратить доступ.

## Відновлення

- Звичайне скидання пароля MFA **не вимикає**. Захоплення акаунта власником непідтвердженої адреси (`claimLocked`) стирає фактори разом з рештою налаштованого до підтвердження.
- Код відновлення (16 символів, 80 біт, одноразовий) відкриває **сесію відновлення**: рівень 1, абсолютний строк `MFA_RECOVERY_WINDOW_SECONDS` (типово 900 с), без WebSocket (`main/init` відповідає `wsToken: null`). Інші сесії завершуються. Дозволені лише `main/init`, маршрути `/account/mfa/*`, `recovery/finish` і `logout`; решта відповідає `403 recovery_session`. Видалити старий фактор чи створити нові коди можна лише після заміни фактора. Після завершення — звичайний вхід з новим фактором.

## Персонал

Службова роль (будь-яка з дозволами) при `MFA_REQUIRED_FOR_STAFF=true` (типово) працює лише з другим фактором. Одна політика [`staffMfaPolicy`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/mfa/staff-mfa-policy.ts) (режим `MFA_STAFF_FACTOR=any`: TOTP або passkey) відповідає на три питання, і її питають усі споживачі ([`staff-policy.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/mfa/staff-policy.ts)):

- **Видача ролі** (адмінка й CLI `user:set-role`) — лише акаунту з фактором: інакше `409 mfa_not_enrolled`. Перший адміністратор із CLI спершу підключає TOTP як звичайний користувач; demo-адмін `db:seed` отримує TOTP із `SEED_ADMIN_TOTP_SECRET`.
- **`can:` і `ws_can:`** — сесія рівня 2 зі свіжим (`MFA_STAFF_FACTOR_MAX_AGE_HOURS`, типово 12 год) доказом фактора, не відновлення. Інакше `403 mfa_required` (немає фактора) або `403 mfa_session_required`; фронтенд веде на `/account?section=security` з поясненням.
- **Підтвердження дій персоналу** (зміна ролі, скидання MFA) — свіжий фактор, для акаунта без MFA — пароль.

Admin-канал WebSocket тримає підписників у порядку їхнього дедлайну й **перед кожною публікацією синхронно відписує прострочених**, тож подія, опублікована в момент `t`, не доходить до сокета з дедлайном `≤ t`, хоч би коли спрацював таймер. Таймер на дедлайн надсилає `access_changed { reason: 'mfa_session_required' }`, і відкрита адмінка йде на вхід. Step-up оновлює `auth` з'єднань цієї сесії на всіх інстансах (подія шини `session_auth_changed`).

**Скидання MFA адміністратором** — `POST /api/admin/users/:id/mfa/reset { reason }` (`can:users.mfa.reset`, лише `admin`) або CLI `pnpm --filter backend user:mfa-reset --email <email> --reason "<чому>"` (`make user-mfa-reset`) — аварійний вихід для останнього адміністратора. Собі — заборонено (`403`: коди відновлення або CLI). Перед записом під блокуванням рядків (за зростанням id) перевіряється виконавець: його токен сесії досі той самий і запис сесії запиту ще існує (завершення саме цієї сесії зі списку сесій і звичайний вихід із неї видаляють запис під тим самим блокуванням рядка; інакше `401 session_revoked`), дозвіл є (інакше `403`), доказ свіжий; так само — зміна ролі. Акаунт, що лишився б без способу входу (лише passkey), — `409 last_sign_in_method` без винятків: користувач спершу встановлює пароль через «Забули пароль». Видаляються TOTP, passkeys і коди, `session_token` ротується (сесії й сокети завершуються), подія `auth.mfa.reset` з причиною, сповіщення й лист власнику.

**Режим `passkey`** (`MFA_STAFF_FACTOR=passkey`, рекомендований): персоналу потрібен passkey, а сесія — вхід або step-up саме passkey (`webauthn` серед методів, свіжа мітка `verified.webauthn`); TOTP лишається другим фактором для звичайних дій акаунта, але не відкриває адмінку. Сервер не стартує в цьому режимі без налаштованого WebAuthn. Видалення фактора staff-акаунта, після якого він не відповідає режиму, — `409 mfa_required_for_role` (у `any` — останній фактор; у `passkey` — останній passkey, навіть якщо TOTP лишається; акаунт лише з TOTP вимикає TOTP після додавання passkey); скидання адміністратором — виняток. `GET /api/account/mfa` повідомляє клієнту `staffFactor`, і staff без passkey бачить банер.

**Порядок перемикання на `passkey`:** налаштуйте `WEBAUTHN_RP_ID` і `WEBAUTHN_ORIGINS` → увімкніть `MFA_REQUIRED_FOR_STAFF` у режимі `any` → персонал додає passkeys (банер підказує) → перемкніть `MFA_STAFF_FACTOR=passkey`. Після перемикання staff без passkey отримує `mfa_required` до реєстрації ключа, а сесії, відкриті через TOTP, — `mfa_session_required`.

::: warning Перехідний ризик
Службові акаунти без фактора, що існували до ввімкнення, і адміністратор `db:seed` у production-like (без `SEED_ADMIN_TOTP_SECRET`) отримують `mfa_required` в адмінці, доки не підключать фактор (рядок 1 матриці: свіжий пароль). Поки фактора немає, той, хто знає пароль такого акаунта, може підключити перший фактор сам. Підключіть фактори персоналу одразу після оновлення.
:::

## Налаштування

| Змінна                                  | Типово                | Що задає                                                                                   |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `MFA_ENCRYPTION_KEYS`                   | —                     | `<keyId>:<base64 32 байти>[,…]`; обов'язкова в production-like                             |
| `AUTH_REAUTH_WINDOW_SECONDS`            | `300`                 | скільки діє step-up                                                                        |
| `MFA_RECOVERY_WINDOW_SECONDS`           | `900`                 | строк сесії відновлення                                                                    |
| `MFA_TICKET_TTL_SECONDS`                | `300`                 | життя квитка другого кроку                                                                 |
| `MFA_RESERVATION_TTL_SECONDS`           | `30`                  | скільки спроба тримає місце в квитку                                                       |
| `AUTH_MFA_VERIFY_MAX_ATTEMPTS_PER_USER` | `10`                  | коди другого кроку й step-up на користувача за вікно                                       |
| `AUTH_MFA_VERIFY_WINDOW_SECONDS`        | `900`                 | вікно цього ліміту                                                                         |
| `OAUTH_FRONTEND_MFA_URL`                | `/login?mfa=required` | куди OAuth веде акаунт з другим фактором                                                   |
| `MFA_REQUIRED_FOR_STAFF`                | `true`                | службова роль працює лише з другим фактором і свіжим доказом                               |
| `MFA_STAFF_FACTOR`                      | `any`                 | фактор персоналу: `any` (TOTP або passkey) або `passkey` (рекомендовано)                   |
| `MFA_STAFF_FACTOR_MAX_AGE_HOURS`        | `12`                  | скільки діє доказ фактора для персоналу                                                    |
| `WEBAUTHN_RP_ID`                        | хост `FRONTEND_URL`   | RP ID passkeys; обов'язкова в production-like, не змінюється після запуску                 |
| `WEBAUTHN_RP_NAME`                      | `APP_NAME`            | назва в діалозі passkey                                                                    |
| `WEBAUTHN_ORIGINS`                      | origin `FRONTEND_URL` | точні origin церемоній через кому (`https://` у production-like), кожен на RP ID або нижче |

Секрет TOTP зберігається зашифрованим (AES-256-GCM, власник як associated data). Перший ключ списку шифрує, решта читають — так ключі обертаються без перешифрування. Без `MFA_ENCRYPTION_KEYS` поза продакшеном ключ виводиться з `APP_KEY` (з попередженням у лозі). Втрата всіх ключів робить недійсними всі TOTP-фактори.

## Журнал і сповіщення

Події `auth.mfa.totp.enabled|replaced|disabled`, `auth.mfa.recovery_codes.regenerated`, `auth.mfa.recovery_code.used`, `auth.passkey.added|removed|counter_regressed`, `auth.mfa.reset` пишуться в [журнал дій](./audit-log) з доказом (`metadata.proof`). Кожна зміна факторів надсилає сповіщення безпеки й лист на адресу акаунта.
