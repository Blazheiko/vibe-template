# Ролі й окремі дозволи — покроковий task list

**Редакція 1** (2026-11-21).

Джерело: [`roles-permissions-plan.md`](./roles-permissions-plan.md) (редакція 5.1, погоджено
власником: рішення Р1–Р13, Д1–Д9). Дві фічі (Д6):

- `feat-240` **Roles And Permissions Core**, гілка `feat/roles-permissions-core`: T0–T9;
- `feat-241` **Role Assignment**, гілка `feat/role-assignment`, залежить від `feat-240`: U0–U5.

Базовий шлях: `packages/`, якщо не вказано інше. Коміт для посилань: `302f171`. T1–T8 збігаються
з таблицею задач плану, T0 і T9 — старт і закриття `feat-240`. Задачі T9–T12 плану тут — U1–U4, U0
і U5 — старт і закриття `feat-241`. Задача або підзадача — один коміт або
кілька дрібних і закінчується зеленим вузьким тестом свого рівня. Позначення тестів:

- `shared/test/*` — `pnpm --filter shared test`;
- `*.spec.ts` — `pnpm --filter backend test` або `pnpm --filter frontend test`;
- `*.pg.test.ts` — `make test-pg`;
- `*.redis.test.ts` — `make test-redis`;
- `frontend/e2e/` — `pnpm --filter frontend test:e2e` (мокований бекенд);
- `frontend/e2e-live/` — `pnpm --filter frontend test:e2e:live` (справжній бекенд).

**Definition of Done (кожна фіча):** `make check`; `make test-pg` і `make test-redis` з кількістю
виконаних і пропущених тестів (або посилання на CI-джоби `test-pg`, `test-redis`); `test:e2e` і
`test:e2e:live`; `pnpm docs:build && pnpm docs:verify`; ручний прохід golden path. Усе це в
`feature-state/<feat-id>/progress.md` → Evidence of Completion. Повний `make check` — після
останньої правки, перед push.

**Незмінне:** поведінка `admin` (усі маршрути як зараз), коди відповідей наявних маршрутів, `401`
від `auth_guard` для анонімного запиту, канонічне тіло `403`. Змінюється лише те, що названо в
задачах.

---

## feat-240 · Roles And Permissions Core

### Порядок

| Задача | Залежить від |
| ------ | ------------ |
| T1     | T0           |
| T2     | T1           |
| T3     | T1, T2       |
| T4     | T3           |
| T5     | T2, T3       |
| T6     | T3, T5       |
| T7     | T3, T6       |
| T8     | T3–T7        |
| T9     | усі          |

### T0 · Старт

- [ ] Реєстраційний PR до `main` (гілка `chore/feat-240-241-register`): план, цей task list,
      записи `feat-240` і `feat-241` (`not-started`, `dependencies: ['feat-240']` у `feat-241`).
- [ ] PR статусу (гілка `chore/feat-240-start`): `feat-240` → `in_progress`.
- [ ] Гілка `feat/roles-permissions-core` від `main`, `feature-state/feat-240/progress.md` і
      порожній `session-handoff.md`.
- [ ] `./init.sh` зелений, результат у `progress.md`; червоний — зупинитися й зафіксувати.

### T1 · Каталог ролей і дозволів (`shared`) — Р2, Р11

- [ ] `shared/src/access/index.ts` (і експорт `shared/access` у `package.json`, як `shared/audit`):
    - `ROLES = ['user', 'support_operator', 'kb_editor', 'user_admin', 'admin'] as const`, `Role`;
    - `PERMISSIONS` (10 дозволів таблиці Р2), `Permission`;
    - `ROLE_DEFINITIONS: Record<Role, { permissions; assignableRoles }>` за таблицею Р2; `admin`
      отримує `PERMISSIONS` цілком і `assignableRoles = ROLES`;
    - `roleHasPermission`, `canAssignRole(actorRole, fromRole, toRole)` (обидві ролі цілі в
      `assignableRoles` виконавця), `isStaffRole`, `STAFF_ROLES`.
- [ ] Схема ролі `RoleSchema = type.enumerated(...ROLES)`; замінити `'user' | 'admin'` у
      `shared/responses/main-controller.ts`, `auth-controller.ts`,
      `admin-audit-events-controller.ts` (`role` і `from`/`to` зміни ролі) і `role: 'string'` у
      `admin-online-user-controller.ts`.
- [ ] Тести `shared/test/access.test.*`:
    - кожен дозвіл ролі є в `PERMISSIONS`; `admin` має всі; `audit.read` ⇒ `audit.read.account`;
    - `assignableRoles` непорожній ⇔ `users.roles.assign`;
    - жодна роль, крім `admin`, не видає `admin` чи роль із `users.roles.assign`; замикання
      делегування кожної ролі дорівнює її `assignableRoles`;
    - `canAssignRole` — повна таблиця 5 × 5 × 5, очікування записані в тесті явно (не з
      каталогу): `user_admin` — лише переходи між `user`/`support_operator`/`kb_editor`; ціль
      `admin`/`user_admin` і нова роль `user_admin`/`admin` — заборонено; `admin` — усе; інші
      ролі — нічого.

### T2 · Міграції і фікстури — Р3, Р11

- [ ] **Спершу фікстури.** `grep` по `packages/backend/src` і `packages/frontend/e2e-live` за
      вставками `role: 'admin'` (і `role` загалом): кожна staff-вставка отримує
      `emailVerifiedAt`. Зокрема `insertUser` у `admin-ws-revocation.pg.test.ts:122`. Список
      знайдених файлів — у `progress.md`.
- [ ] `database/schema.ts`: значення `user_role` з `ROLES`; `check('users_staff_role_verified_email',
sql\`role = 'user' OR email_verified_at IS NOT NULL\`)`.
- [ ] `db:generate` → дві міграції (Drizzle 1.0, папки): (1) `ALTER TYPE "user_role" ADD VALUE`
      ×3 без даних; (2) `CHECK`. Коментар у SQL другої: чому обмеження і що робити з локальним
      непідтвердженим адміністратором.
- [ ] `UserRow['role']` (`user-repository.ts:46`) і `UserConnection.role`
      (`vendor/types/types.d.ts:21`) — тип `Role`.
- [ ] PG (`users-role-schema.pg.test.ts`): міграції на чисту БД; вставка кожної нової ролі з
      підтвердженою поштою проходить; `INSERT` і `UPDATE` staff-ролі без `email_verified_at`
      падають на `CHECK`; `user` без підтвердження — проходить.
- [ ] Вручну (evidence): локальна БД з непідтвердженим `admin` → міграція відхиляє зі зрозумілою
      помилкою; після підтвердження — проходить.

### T3 · Guard дозволів і розбиття маршрутів — Р4, Р11

- [ ] `app/middlewares/permission-guard.ts`: `permissionGuard(permission)` — `findRole`,
      `roleHasPermission`, інакше канонічний `403` (`forbidden`, як зараз); `rememberActorRole`
      (ім'я лишається, бо його читають `audit-actor.ts` і T4).
- [ ] `app/middlewares/ws-permission-guard.ts`: `wsPermissionGuard(permission)` за
      `context.userData.role` і `adminChannelPaused` (поле з T6, тут — `false` за замовчуванням).
- [ ] `kernel.ts`: записи `can:<permission>` і `ws_can:<permission>` генеруються з
      `PERMISSIONS`; `admin_guard`, `ws_admin_guard` і їхні файли й spec видаляються.
- [ ] `routes/http-routes.ts`: групи за дозволом, порядок
      `['session_web', 'csrf_guard', 'auth_guard', 'can:…']`: `kb.read`, `kb.write`, `kb.manage`
      (`reindex-all`, `init`), `prompts.manage` (усі чотири маршрути, включно з `GET /prompts`),
      `ai_usage.read`, `users.read` (`/admin/users`, `/admin/users-online`),
      `users.sensitive.read` (`/admin/users-online/:id`, `/admin/history-online`),
      `audit.read.account` (`/admin/audit-events`).
- [ ] `routes/ws-routes.ts`: `subscribe_online_users` — група `admin` з `ws_can:users.read`;
      `unsubscribe_online_users` — окрема група з тим самим `prefix` без `ws_can:`.
      `admin-ws-channel-service`: перевірка `roleHasPermission(role, 'users.read')`, відписка
      ідемпотентна для будь-якої ролі.
- [ ] Тести:
    - `permission-guard.spec.ts`, `ws-permission-guard.spec.ts` — `403` для невідомого
      користувача й ролі без дозволу, пропуск з дозволом, роль запам'ятовано;
    - `route-permissions.spec.ts` (HTTP-матриця) за реальними маршрутами: кожен `/admin/*` і
      `/prompts*` має рівно один `can:` з відомим дозволом; порядок middleware; анонімний — `401`
      до `can:`; роль × маршрут — `403` або пропуск за **незалежною** таблицею в тесті; немає
      `admin_guard`;
    - `ws-route-permissions.spec.ts` (WS-матриця): кожен `admin/*` має `ws_can:`, крім явного
      винятку `unsubscribe_online_users`; роль × маршрут за незалежною таблицею; відписка й
      повторна відписка — успіх для будь-якої ролі;
    - наявний `route-access.spec.ts` і `admin-audit-events-http.pg.test.ts` — оновити під нові
      імена middleware.

### T4 · Обмеження журналу — Р5

- [ ] `AdminAuditEventsController` передає сервісу, чи має виконавець `audit.read` (роль із
      guard).
- [ ] `audit-events-query-service.ts`: без `audit.read` — **до** `actionsOf` перевірити явні
      `group`, кожну дію `action` і `targetType`; будь-що поза `sign-in`/`sessions`/`user` —
      `403 forbidden`. Потім у фільтр репозиторію: `actions` = дозволені дії (або їх перетин із
      запитаними) і `targetType = 'user'` — у `WHERE` до курсора й `LIMIT`.
- [ ] PG (у `admin-audit-events-http.pg.test.ts`): `support_operator` — `403` на `group=kb`, на
      `group=sign-in&action=kb.article.updated`, на `targetType=kb_article`; без фільтрів — лише
      дії `sign-in`/`sessions`; сторінки повні поверх перемішаних подій усіх груп (три сторінки,
      жодного чужого рядка, жодної короткої сторінки, крім останньої); `admin` — як раніше.

### T5 · Подія, сервіс зміни ролі, CLI — Р6, Р7

- [ ] `shared/audit/audit-actions.ts`: `AUDIT_SYSTEM_SOURCES = ['seed', 'cli']`; дія
      `user.role.changed` (`rights`, `user`, виконавці `user` і `system`, `changes: { role:
fromTo }`, `metadata: { source }` лише для `system`); тест найгіршого розміру payload за
      правилами журналу.
- [ ] `services/user/role-assignment-service.ts`, `assign({ actor, targetUserId, role })` у
      `withTransactionResult`:
    1. `pg_advisory_xact_lock(hashtextextended('user_role_change', 0))` — метод репозиторію
       `lockRoleChanges(tx)`, як `lockPhoneFlow`;
    2. перечитати виконавця (для `user`) і ціль (`role`, `email_verified_at`);
    3. правила 1–6 Р6 у такому порядку: ціль існує (`404`); власна роль, `users.roles.assign`,
       `canAssignRole` (`403`, лише для `user`); та сама роль → `changed: false` без `UPDATE`;
       staff-роль без підтвердженої пошти → `conflict('…', 'identity_unverified')`; пониження
       останнього `admin` → `conflict('…', 'last_admin')`;
    4. `UPDATE … RETURNING role`; подія `user.role.changed` зі `stamp(tx)` і `actor_role` з кроку 2;
    5. після коміту — `logCommitted` і `userEventBus.notifyServer(userId, 'user_role_changed')`
       (T6; до T6 — заглушка, що нічого не робить).
- [ ] CLI `src/scripts/user-set-role.ts`, `package.json` `"user:set-role"`, ціль `Makefile`
      `user-role: ## Assign a role to a user by email (ARGS="--email … --role …")`: розбір
      аргументів (окремий spec, як `run-job-args.spec.ts`), виконавець `system`
      (`source: 'cli'`), вивід результату; відмова — `reason` і код виходу 1. Публікація — T6.
- [ ] PG (`role-assignment-service.pg.test.ts`):
    - подія в транзакції; збій запису журналу — відкат без зміни ролі; та сама роль — без
      `UPDATE` і події;
    - `user_admin`: `user`→`kb_editor` проходить; ціль `admin` чи `user_admin`, нова роль
      `admin`/`user_admin`, власна роль — `403`; тіло `403` канонічне;
    - staff-роль непідтвердженому — `409 identity_unverified` від `user` і від CLI; тіло
      `{ status: 'error', code: 'conflict', reason }`;
    - **конкурентність 1:** два паралельні `system`-пониження двох останніх `admin` — один успіх,
      один `409 last_admin`, у БД один `admin`, у журналі одна подія;
    - **конкурентність 2:** тест-транзакція бере advisory lock і понижує виконавця-`user_admin`;
      паралельний `assign` від нього чекає й отримує `403`, роль цілі не змінена.
- [ ] Мутації (результат у `progress.md`): прибрати advisory lock → падає конкурентність 1;
      брати роль виконавця з guard → падає конкурентність 2.

### T6 · Синхронізація ролі з'єднань — Р7, Р8

- [ ] `user-event-bus.ts`:
    - `SERVER_BUS_EVENTS = ['user_role_changed']` з обробником `onServerEvent(event, userId)`;
      серверні події не доставляються клієнтам і не входять у `BUS_EVENTS`;
    - `notifyServer(userId, event)` — локальний обробник одразу, плюс публікація в канал, якщо
      шину запущено;
    - `publishRemote(userId, event)` — лише `PUBLISH` конверта, без локальної доставки й без
      підписника (для CLI).
- [ ] `app/websocket/ws-role-sync.ts` (заміна `admin-ws-access-service.ts`, видаляється):
    - `refreshUsers(userIds)`: номер читання на старті; `findRolesByIds`; для кожного сокета —
      пропустити, якщо застосовано новіше читання; присвоїти `userData.role`; втрата `users.read`
      — відписка від `admin`; змінилася роль — сокету `access_changed { role }` **після**
      присвоєння;
    - збій читання: сокети цих користувачів, підписані на `admin`, — відписка й
      `adminChannelPaused = true`; наступне успішне читання знімає позначку й з `users.read`
      надсилає `admin_channel_ready`; сервер **не** підписує сам;
    - періодичний прохід: усі `userId` з'єднань інстансу, пачки по 1000, без накладання проходів,
      `WS_ROLE_RECHECK_INTERVAL_MS` (перейменування в `config/websocket.ts` і `.env.example`).
- [ ] `shared/schemas/ws/broadcast-events.ts`: `access_changed { role }`, `admin_channel_ready {}`;
      `frontend/src/utils/ws-payload-guards.ts` — guard-и.
- [ ] CLI (T5) після коміту — `publishRemote`; збій — попередження, вихід 0 (роль уже змінено).
- [ ] Тести:
    - `ws-role-sync.spec.ts`: обидва напрямки; `access_changed` лише при зміні й після
      присвоєння; старіше читання, що завершилося пізніше, відкидається; пачки; пауза →
      `admin_channel_ready` без підписки; без `users.read` — сигналу немає;
    - `admin-ws-revocation.pg.test.ts`: тест «підвищення потребує перепідключення» (рядок 293)
      інвертувати — на тому самому сокеті `access_changed`, потім `subscribe` → `200` і події
      надходять; пропущений сигнал (лише прохід) для підвищення й пониження; пауза (збій
      `findRolesByIds`) → `unsubscribe` → відновлення → подій немає; перепідключення з тією самою
      роллю → `subscribe` → події;
    - `user-event-bus.redis.test.ts`: `user_role_changed` з іншого інстансу викликає обробник і не
      доходить до клієнта; `publishRemote` без `start()`;
    - `user-set-role-cli.redis.test.ts`: **справжній процес** `tsx src/scripts/user-set-role.ts`
      (як `purge-llm-prompts-cli.redis.test.ts`) змінює роль, а підписаний у тесті інстанс шини
      отримує сигнал.

### T7 · Frontend і `GET /account/access` — Р8, Р10

- [ ] Backend: `GET /account/access` (`auth_guard`) → `{ status: 'success', role }`; контракт у
      `shared/contracts/account.ts`, схема в реєстрі, тест контролера.
- [ ] `useWebSocketConnection`: лічильник покоління сокета (збільшується з кожним новим
      з'єднанням), доступний composable-ам.
- [ ] `stores/user.ts`: `can`, `isStaff`, `accessEpoch` (+1 на `access_changed` і на зміну
      акаунта), `refreshAccess()` з номером запиту; відповідь застосовується лише за незмінного
      `accessEpoch` і найновішого номера. Виклики: `ws_ready`, `visibilitychange` → `visible`.
      `isAdmin` прибрати, усі використання — на `can`/`isStaff`.
- [ ] `composables/useAdminChannel.ts` (замість `subscribeAdminChannel` в `AdminLayout.vue:24`):
    - стан «потрібна» = змонтовано і `can('users.read')`; «підтверджена» = покоління сокета, для
      якого остання відповідь мала `data.status === 'success'`;
    - підписка, якщо потрібна й не підтверджена для поточного покоління, на: монтування, появу
      дозволу, `ws_ready`, `access_changed` (навіть із тією самою роллю), `admin_channel_ready`;
    - **`admin_channel_ready` спершу скидає підтвердження для поточного сокета** (сервер відписав
      його на час паузи), потім підписка; після успішної відповіді — подія для перечитування
      списку онлайн;
    - відповідь для старого покоління відкидається; `403` — без повторів у циклі;
    - вихід з адмінки або втрата дозволу — відписка.
- [ ] Router: `meta.permission` на дочірніх `/admin`; батьківський — `isStaff`; `/admin` →
      перша доступна сторінка; переоцінка guard поточного маршруту при зміні ролі.
- [ ] `AdminLayout.vue`: пункти меню з `permission`, фільтр. `AdminKnowledgeBaseView`: режими
      `kb.write`/`kb.manage`. `AdminUserOnlineView`: деталі лише з `users.sensitive.read`,
      перечитування списку за подією з `useAdminChannel`. `AdminHistoryOnlineView` — маршрут з
      `users.sensitive.read`. `AdminAuditLogView`: без `audit.read` — групи й дії лише
      `sign-in`/`sessions`. Назви ролей — через тексти інтерфейсу.
- [ ] Unit (`__tests__`): `can`, guard роутера, фільтр меню, режими бази знань і журналу;
      `accessEpoch` (відповідь, розпочата до `access_changed` або зміни акаунта, відкидається;
      відповідь не в порядку відкидається); `useAdminChannel`: `403` без циклу, повтор на
      `access_changed` з тією самою роллю, підписка на `ws_ready` з новим поколінням, відповідь
      старого покоління відкинуто, **парний тест паузи починається зі стану «підтверджено»**:
      `admin_channel_ready` → повторна підписка → перечитування списку; адмінка закрита →
      `admin_channel_ready` без підписки.
- [ ] e2e (мокований бекенд, `frontend/e2e/mock/`): навігація й меню для кожної ролі;
      `support_operator` у базі знань без кнопок змін.

### T8 · Документація — Р12

- [ ] Обидві локалі: `reference/roles-capabilities.md` (матриця ролей), `backend/auth.md`,
      `middlewares.md`, `routing.md`, `websocket.md` (`ws_can:`, `wsRoleSync`, `access_changed`,
      `admin_channel_ready`, пауза каналу, інтервал як очікувана затримка за доступної БД,
      серверні події шини), `audit-log.md` (`user.role.changed`, `cli`, `audit.read.account`),
      `account` (`GET /account/access`), `reference/scripts` (`user:set-role`, `make user-role`),
      конфігурація (`WS_ROLE_RECHECK_INTERVAL_MS`), `glossary.md`.
- [ ] Розділ «Як додати роль або дозвіл».
- [ ] `docs/reference/template-role-capability-matrix.md`.
- [ ] Туторіал `adding-a-feature.md` (обидві локалі) і `.claude/skills/backend-feature/SKILL.md`
      (рядки 42, 493): `can:<дозвіл>` / `ws_can:<дозвіл>` замість `admin_guard` /
      `ws_admin_guard`.
- [ ] `pnpm docs:build && pnpm docs:verify`.

### T9 · Перевірка, рев'ю, закриття

- [ ] DoD (вище) з лічильниками в `progress.md`.
- [ ] Мутації — кожна ламає названий тест:

    | Мутація                                                | Тест, що падає                        |
    | ------------------------------------------------------ | ------------------------------------- |
    | прибрати `can:` з одного маршруту                      | HTTP-матриця                          |
    | дати `support_operator` `kb.write` у каталозі          | HTTP-матриця (незалежна таблиця)      |
    | `user_admin` може видати `user_admin`                  | тест замикання делегування            |
    | без advisory lock                                      | конкурентність 1 (T5)                 |
    | роль виконавця з guard замість читання під блокуванням | конкурентність 2 (T5)                 |
    | `access_changed` до присвоєння `userData.role`         | підвищення на тому самому сокеті (T6) |
    | сервер сам підписує після паузи                        | пауза → вихід (T6)                    |
    | `admin_channel_ready` не скидає підтвердження          | парний тест паузи (T7)                |
    | не перевіряти `action` до перетину з `group`           | `403` на заборонену дію (T4)          |

- [ ] Ручний прохід: CLI призначає `kb_editor` і `support_operator` підтвердженим акаунтам, кожен
      бачить лише своє меню й не може виконати чужу дію (прямий запит — `403`); CLI понижує
      відкриту вкладку — вона переходить на `/account` без перезавантаження; CLI відмовляє
      непідтвердженому й останньому адміністратору; події в `/admin/audit-log`.
- [ ] PR `feat/roles-permissions-core` → `main`; PR статусу `review`; після рев'ю й мерджу — PR
      «Mark feat-240 done» (evidence, видалити `feature-state/feat-240/`).

---

## feat-241 · Role Assignment

Починається, коли `feat-240` у статусі `done`.

### U0 · Старт

- [ ] PR статусу: `feat-241` → `in_progress`; гілка `feat/role-assignment`,
      `feature-state/feat-241/`; `./init.sh` зелений.

### U1 · `PATCH /admin/users/:id/role` і список — Р6, Р9 (план T9)

- [ ] Контракт `adminContracts.setUserRole` (`patch`, `/admin/users/:id/role`), тіло
      `{ role: RoleSchema }`, відповідь `{ status, user: { id, role }, changed }`; схема в
      реєстрі; група з `can:users.roles.assign` і rate limit.
- [ ] Контролер: `parseEntityId`, `auditActorFrom`, виклик `roleAssignmentService.assign`,
      `mapControllerError` (`403`, `404`, `409` з `reason`).
- [ ] `GET /admin/users`: `role` в елементі, фільтр `role?` (query-схема, репозиторій).
- [ ] PG (`admin-user-role-http.pg.test.ts`): HTTP-шлях кожного правила Р6, тіла помилок,
      подія журналу з `actor_kind = 'user'` і `request_id`; фільтр `role`; HTTP-запит щойно
      пониженого виконавця — `403` (конкурентність 2 через HTTP).
- [ ] HTTP-матриця (T3) отримує новий маршрут у незалежній таблиці.

### U2 · Frontend — Р10 (план T10)

- [ ] `AdminUsersView`: колонка й фільтр ролі; з `users.roles.assign` — дія «Змінити роль» лише з
      `assignableRoles`, без дії для власного рядка й недоступних цілей.
- [ ] Діалог: підтвердження, тексти для `403`, `404`, `409 last_admin`, `409 identity_unverified`;
      `changed: false` — без повідомлення про зміну.
- [ ] Unit і e2e (мокований бекенд, `frontend/e2e/mock/admin-users.spec.ts`): вибір ролей за
      роллю виконавця, помилки.

### U3 · e2e-live — Р11 (план T11)

- [ ] `frontend/e2e-live/roles.spec.ts`: адміністратор (`USER_2`) призначає зареєстрованому
      користувачу з підтвердженою поштою `kb_editor` → той бачить лише базу знань і змінює
      статтю; `support_operator` не має кнопок змін, прямий запит — `403`, історії підключень
      немає; пониження при відкритій вкладці → `/account` без перезавантаження; спроба видати
      роль непідтвердженому — текст помилки.

### U4 · Документація — Р12 (план T12)

- [ ] Сторінка адмін-API (обидві локалі): новий маршрут, правила, помилки; матриця ролей —
      `users.roles.assign` через UI; `pnpm docs:build && pnpm docs:verify`.

### U5 · Перевірка, рев'ю, закриття

- [ ] DoD з лічильниками; ручний прохід golden path через UI; PR `feat/role-assignment` → `main`;
      PR статусу `review`; після мерджу — «Mark feat-241 done».
- [ ] Оновити рекомендації (`future/template-functionality-recommendations.md`): пункт 6 —
      «реалізовано `feat-240`, `feat-241`».
