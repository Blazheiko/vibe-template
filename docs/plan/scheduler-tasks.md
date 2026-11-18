# Планувальник фонових задач — покроковий task list

Джерело: [`scheduler-plan.md`](./scheduler-plan.md) (редакція 5, рішення Р1–Р13). Базовий шлях: `packages/backend/src/`, якщо не вказано інше. Коміт для посилань на рядки: `50af172`.

Кожна фіча — окремий рядок у `feature_list.json`, гілка і PR (правила `AGENTS.md`). Задача T* — один коміт або кілька дрібних; вона закінчується зеленим вузьким тестом свого рівня. Позначення тестів: `*.spec.ts` — `pnpm --filter backend test`; `*.redis.test.ts` — `make test-redis`; `*.pg.test.ts` — `make test-pg` (з `REDIS_TEST_URL`, де вказано).

**Definition of Done для кожної фічі:** `make check`; `make test-redis` і/або `make test-pg` з кількістю виконаних і пропущених тестів у доказах (або посиланням на CI-джоби `test-redis`/`test-pg`); `pnpm docs:build && pnpm docs:verify`, якщо змінено `documentation/`; ручна перевірка golden path; усе це в `feature-state/<feat-id>/progress.md` → Evidence of Completion.

## Відповідність і порядок

| Фіча       | Гілка                           | Задачі  | Залежить від |
| ---------- | ------------------------------- | ------- | ------------ |
| `feat-222` | `feat/scheduler-core`           | T1–T12  | —            |
| `feat-223` | `feat/auth-token-cleanup-job`   | T13–T18 | `feat-222`   |
| `feat-224` | `feat/llm-prompt-retention-job` | T19–T23 | `feat-222`   |

`feat-223` і `feat-224` незалежні одна від одної: після `done` для `feat-222` їх можна вести паралельно (окремі worktree).

Порядок усередині `feat-222`: T1 → T2 → (T3, T4 паралельно) → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12.

---

## feat-222 · Ядро планувальника

### T1 · Старт фічі

- [ ] PR до `main` з короткої гілки (`chore/feat-222-start`): `feat-222` → `in_progress`.
- [ ] Гілка `feat/scheduler-core` від `main`, `feature-state/feat-222/progress.md` і `session-handoff.md`.
- [ ] `./init.sh` зелений; результат у `progress.md`.

### T2 · `Checkpoint` і розклад (`schedule.ts`) — Р2

**Зміни**

- [ ] `app/services/shared/checkpoint.ts`: `export type Checkpoint = () => void` і `noCheckpoint` (no-op для викликів поза задачами). Тип живе в `services/shared`, щоб сервіси й репозиторії не імпортували `app/scheduler`.
- [ ] `app/scheduler/schedule.ts`:
    - `parseScheduleDuration(raw)`: обгортка `duration()` з `metautil`; приймає лише цілі значення з одиницею (`^\d+[dhms]( \d+[dhms])*$`), результат > 0, інакше кидає з текстом, що містить сире значення;
    - `type Schedule = { every: string } | { dailyAt: string }`, `validateSchedule(schedule)`: `every` ≥ `1m`, ціле число хвилин, `86_400_000 % interval === 0`; `dailyAt` за `^([01]\d|2[0-3]):[0-5]\d$`;
    - `slotOf(schedule, nowMs): number` — початок поточного слоту в мс епохи: `floor(now / interval) * interval` для `every`; для `dailyAt` — сьогоднішній `HH:MM` UTC, якщо він уже настав, інакше вчорашній.

**Тести** (`app/scheduler/schedule.spec.ts`)

- [ ] `every: '15m'`: 03:14:59.999 → 03:00, 03:15:00.000 → 03:15; однаковий результат для різних `now` в одному слоті.
- [ ] `dailyAt: '03:00'`: 02:59:59 → учорашній 03:00; 03:00:00 → сьогоднішній; 23:59 → сьогоднішній; перехід через добу, місяць і рік (31 грудня → 1 січня).
- [ ] Відмова: `'15'`, `'-5m'`, `'1.5h'`, `'0m'`, `'30s'`, `'7m'` (1440 не ділиться на 7), `'24:00'`, `'3:00'`, `'03:60'`.

### T3 · `redis-lease.ts`: `abandon()`, `checkpoint()`, `evalAsOwner()` — Р10–Р12

**Зміни** (`app/services/shared/redis-lease.ts`)

- [ ] Зберігати `lostAt` (монотонний момент, який рахує `armDeadline`) у замиканні, оновлювати при кожному успішному продовженні.
- [ ] `HeldLease.checkpoint(): void`: кидає `lost.reason`, якщо `lost.aborted`; кидає `lostError('the local deadline passed')` і викликає `markLost`, якщо `performance.now() >= lostAt`, не чекаючи таймера.
- [ ] `HeldLease.abandon(): void`: `released = true`, `stopTimers()`, ключ не чіпає; повторні `abandon()`/`release()` — no-op (`release()` після `abandon()` повертає `false` без звернення до Redis).
- [ ] `HeldLease.evalAsOwner(script, keys, args): Promise<unknown>`: виконує Lua, де `KEYS[1]` — ключ lease, `ARGV[1]` — токен, далі передані `keys`/`args`. Скрипт мусить почати з `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'not-owner' end`. Токен назовні не видається.
- [ ] Наявні виклики (`support-inflight-lock.ts`, `knowledge-base-init-service.ts`) не змінюються.

**Тести**

- [ ] `redis-lease.spec.ts` (фейкові таймери, мок Redis): `checkpoint()` кидає після синхронного очікування за `lostAt`, коли callback дедлайну ще не виконувався (таймери не просунуті); не кидає до `lostAt`; після `abandon()` таймери не спрацьовують.
- [ ] `redis-lease.redis.test.ts` (новий): після `abandon()` ключ існує, `PTTL` ≤ `ttlMs`, а інший `acquireLease` отримує `null`, доки ключ не протермінується; після протермінування — отримує lease. `evalAsOwner` після `DEL` ключа і після перехоплення іншим власником повертає `'not-owner'` і нічого не пише.

### T4 · `leaseForJob` — Р13

- [ ] `app/scheduler/job-lease.ts`: `leaseForJob(timeoutMs): Lease` = `leaseForDatabaseWrites({ ttlMs: 15_000, renewEveryMs: 5_000, maxLifetimeMs: timeoutMs + DATABASE_WRITE_BOUND_MS + JOB_FINALIZE_MARGIN_MS })`, `JOB_FINALIZE_MARGIN_MS = 10_000`.
- [ ] `job-lease.spec.ts`: для будь-якого `timeoutMs` з набору (`1m`, `5m`, `10m`) `maxLifetimeMs > timeoutMs + DATABASE_WRITE_BOUND_MS`; `ttlMs` ≥ `DATABASE_WRITE_BOUND_MS + 1000 + 2 × renewEveryMs`.

### T5 · Контракт задачі (`job.ts`) — Р7, Р8

- [ ] `app/scheduler/job.ts`:
    - `JobContext = { signal: AbortSignal; checkpoint: Checkpoint; slot: number; dryRun: boolean; logger }`;
    - `JobResult = { matched: number; changed: number }`;
    - `defineJob({ name, schedule, timeout, run })` перевіряє kebab-case ім'я, `validateSchedule`, `parseScheduleDuration(timeout)`;
    - `type Outcome = 'ok' | 'failed' | 'timeout' | 'lease-lost' | 'shutdown' | 'skipped-locked' | 'skipped-backoff'` і `categoryOf(outcome)` → `success`/`failure`/`aborted`/`skipped`.
- [ ] `job.spec.ts`: відмова на некоректне ім'я, розклад, timeout; `categoryOf` для кожного значення.

### T6 · Стан у Redis (`scheduler-state.ts`) — Р3, Р11

**Зміни**

- [ ] `readState(job)`: `HGETALL sched:state:<job>` → `{ lastSuccessSlot?, consecutiveFailures, nextRetryAt?, lastRunAt?, lastOutcome?, lastDurationMs? }`.
- [ ] `recordSuccess(lease, job, { slot, durationMs, now })` через `lease.evalAsOwner`: `lastSuccessSlot = max(old, slot)`, `consecutiveFailures = 0`, `HDEL nextRetryAt`, `lastRunAt`/`lastOutcome`/`lastDurationMs`.
- [ ] `recordFailure(lease, job, { outcome, durationMs, now, maxBackoffMs })` через `evalAsOwner`: `failures + 1`, `nextRetryAt = now + min(60_000 × 2^(failures − 1), maxBackoffMs)`; повертає обчислений `nextRetryAt` (для локального backoff).
- [ ] Обидві функції повертають `'written' | 'not-owner'`; помилка Redis кидається далі.
- [ ] `maxBackoffOf(schedule)`: `min(every, 1h)` для `every`, `1h` для `dailyAt`.

**Тести** (`scheduler-state.redis.test.ts`)

- [ ] `lastSuccessSlot` не відкочується (запис меншого слоту лишає більший).
- [ ] Backoff: 1m, 2m, 4m … до максимуму; після `recordSuccess` — `consecutiveFailures = 0`, `nextRetryAt` немає.
- [ ] **Колишній власник:** А бере lease, ключ видаляється, Б бере lease і пише успіх; запис А (`recordFailure` або `recordSuccess`) повертає `'not-owner'`, стан Б незмінний.
- [ ] `maxBackoffOf` — юніт у `scheduler-state.spec.ts`.

### T7 · Ядро (`scheduler.ts`) — Р3–Р8, Р10

**Зміни**

- [ ] `createScheduler({ jobs, clock, acquire, state, logger, sentry, tickMs, stopDrainMs })`; залежності впроваджуються, за замовчуванням — справжні.
- [ ] Цикл: `setTimeout` з `node:timers/promises` (`{ signal: stopSignal }`), інтервал `tickMs × (0.8 + 0.4 × random)`; задачі в порядку реєстру, по одній.
- [ ] Для кожної задачі: локальний `nextRetryAt` (якщо в майбутньому — `skipped-backoff`, без звернення до Redis) → `acquire(sched:lease:<job>, leaseForJob(timeout))` (`null` → `skipped-locked`) → `readState` → due, якщо `lastSuccessSlot < slotOf(...)` і `now ≥ nextRetryAt` (інакше `release()` і `skipped-backoff` або нічого) → `run(ctx)`.
- [ ] `ctx.signal = AbortSignal.any([lease.lost, AbortSignal.timeout(timeout), stopSignal])`; `ctx.checkpoint = () => { ctx.signal.throwIfAborted(); lease.checkpoint() }`; `dryRun: false`.
- [ ] Класифікація після `run()`: перерваний сигнал → `timeout` / `lease-lost` / `shutdown` за `signal.reason` навіть при успішному поверненні; виняток → `failed` (або за причиною сигналу, якщо він перерваний); інакше `ok`.
- [ ] Запис: `ok` → `recordSuccess`; `failed`/`timeout` → `recordFailure`; `'not-owner'` → `outcome = lease-lost`, локальний backoff; помилка Redis → локальний backoff з тим самим розрахунком; `shutdown`/`lease-lost` → стан не пишеться.
- [ ] Після `run()` завершився: `release()` у `try/catch` (`warn`).
- [ ] Лог pino на запуск (поля Р8, `category`); `failed`/`timeout` → `sentryService.captureException` з тегом `job`.
- [ ] `stop()`: припиняє цикл, перериває `stopSignal`, чекає поточну задачу до `stopDrainMs`; завершилась → `release()`, ні → `abandon()`; помилки Redis ловляться; повторний `stop()` — no-op.
- [ ] `runOnce(name, { dryRun, trigger: 'manual' })` для `job:run`: той самий lease і `checkpoint`, стан Р3 не пише, повертає `{ outcome, matched, changed }` (`skipped-locked` → «зайнято»).

**Тести** (`scheduler.spec.ts`, фейковий годинник і фейкові lease/state)

- [ ] Due / not-due; пропущені слоти (стан на 3 доби тому) → один запуск; перший старт (стану немає) → запуск одразу.
- [ ] Backoff: зростання, максимум, обнулення після успіху; локальний backoff при `'not-owner'` і при помилці Redis.
- [ ] `run()`, що повернувся після abort, → `timeout`/`shutdown`, `recordSuccess` не викликано.
- [ ] Задача, що працює до свого timeout, → `timeout`, а не `lease-lost` (з `leaseForJob`).
- [ ] `stop()`: задача завершилася до drain → `release()`; ні → `abandon()`, `release()` не викликано; помилка `release()` не кидає з `stop()`.
- [ ] Послідовність: друга задача стартує після завершення першої.
- [ ] Sentry лише для `failed`/`timeout`.

### T8 · Конфіг і підключення — Р5, Р6

- [ ] `config/scheduler.ts`: `SCHEDULER_ENABLED` (bool, `true`), `SCHEDULER_TICK` (`30s`, 5s…5m), `SCHEDULER_DISABLED_JOBS` (список; невідоме ім'я → `configError`); `config/scheduler.spec.ts`.
- [ ] `app/start/validate-runtime-config.ts`: `configError` планувальника зупиняє старт.
- [ ] `app/scheduler/jobs/index.ts`: реєстр (поки порожній), перевірка унікальності імен.
- [ ] `index.ts`: `scheduler.start()` після `initServer` (лише за `SCHEDULER_ENABLED`); `await scheduler.stop()` у `stopHandler` перед `stopServer`, тобто до закриття пулів і Redis.
- [ ] `app/layering.spec.ts`: `app/scheduler/**` не імпортує `#app/repositories`; негативний контроль як в інших правилах.
- [ ] `packages/backend/.env.example`: три змінні з поясненнями.

### T9 · Ручний запуск (`scripts/run-job.ts`) — Р9

- [ ] `scripts/run-job-args.ts` (чисті функції) + `run-job-args.spec.ts`: `<name>`, `--dry-run`, невідомий аргумент і невідома задача → помилка.
- [ ] `scripts/run-job.ts`: `runOnce`, вивід `matched`/`changed`, «зайнято» → `process.exitCode = 75`, SIGINT → abort; закриває пул і Redis.
- [ ] `package.json`: `"job:run": "tsx src/scripts/run-job.ts"`; `scripts/README.md`.

### T10 · Redis-тести ядра (`app/scheduler/scheduler.redis.test.ts`)

Тестова задача в реєстрі тесту, `every: '1m'`, фейковий годинник лише для слоту, справжній Redis.

- [ ] Два планувальники, один слот → одне виконання.
- [ ] Lease, втрачений під час задачі (тест видаляє ключ): `lease-lost`, наступний `checkpoint()` кидає, стан у Redis незмінний.
- [ ] Redis недоступний (`redis-postponed.ts`): задача не стартує, процес не падає, один `warn` на тік.
- [ ] Рестарт (новий планувальник) після успіху не повторює слот.
- [ ] Помилка на репліці А → репліка Б на наступному тіку дає `skipped-backoff`.
- [ ] Зміни внесено, а `recordSuccess` кидає (фейкове сховище над справжнім Redis): наступний запуск повторює задачу з тим самим результатом.
- [ ] `runOnce` і плановий запуск конкурують: другий отримує `skipped-locked`.

### T11 · PG + Redis тест shutdown (`app/scheduler/scheduler-shutdown.pg.test.ts`)

`DB_QUERY_TIMEOUT_MS = 1000`, `stopDrainMs = 100`, тестова таблиця `sched_test_target` і таблиця подій `sched_test_events`.

- [ ] Тестове з'єднання тримає `LOCK TABLE sched_test_target IN ACCESS EXCLUSIVE MODE`.
- [ ] Репліка А: задача віддає тесту `pg_backend_pid()`, потім `checkpoint()` і запит до `sched_test_target`; тест опитує `pg_stat_activity`, доки `pid` А не матиме `wait_event_type = 'Lock'`, і лише тоді викликає `stop()`.
- [ ] Перевірка: `abandon()` викликано, `release()` — ні; ключ існує, `PTTL < ttlMs`; `acquireLease` під час очікування А → `null`.
- [ ] Репліка Б працює зі своїм коротким тіком, тест нею не керує; її задача першим SQL-кроком робить `INSERT INTO sched_test_events (event, a_active) SELECT 'b-first', EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $pidA AND state = 'active')`. Очікування: рядок є і `a_active = false`.
- [ ] На боці А — код `57014`. Варіант: тест знімає блокування раніше — запит А завершується успішно, решта перевірок та сама.
- [ ] Спостерігач `pg_stat_activity` лише логує час завершення А, у перевірках не бере участі.

### T12 · Документація і закриття feat-222

- [ ] `documentation/backend/scheduler.md` і `documentation/en/backend/scheduler.md`: як додати задачу (`defineJob`, реєстр), контракт `checkpoint` (перед кожним SQL-кроком, без `await` між викликом і запитом), ідемпотентність і безпечність для одночасного запуску, гарантії Р3/Р4, «Межі гарантій», `maxmemory-policy noeviction`, змінні, `job:run`, коди виходу.
- [ ] Сайдбар обох локалей (`documentation/.vitepress/config.ts`), `KEY_PAGES`/`EN_KEY_PAGES` (`documentation/scripts/verify-dist.mjs`); `configuration.md` (обидві локалі) — нові змінні.
- [ ] `documentation/en/backend/adding-a-feature.md` і українська версія: абзац «фонова задача» з посиланням; `.claude/skills/backend-feature/SKILL.md` — те саме посилання.
- [ ] Ручна перевірка: дві копії бекенду на одному Redis, `SCHEDULER_TICK=5s`, тимчасова тестова задача `every: '1m'` (не комітиться): одне виконання на слот; SIGTERM під час задачі → `shutdown`; задача довша за drain → ключ живе до TTL, друга копія не стартує; падаюча задача → обидві копії дотримуються одного `nextRetryAt`; `job:run` під час планового запуску → код 75.
- [ ] Evidence у `progress.md`, `feat-222` → `review`; після merge — PR «Mark feat-222 done».

---

## feat-223 · Чистка прострочених токенів

### T13 · Старт фічі

- [ ] PR до `main`: `feat-223` → `in_progress` (лише після `feat-222` = `done`); гілка `feat/auth-token-cleanup-job`, `feature-state/feat-223/`; `./init.sh`.

### T14 · Аудит читання старих рядків

- [ ] Знайти всі читання `email_verifications`, `email_link_verifications`, `password_reset_tokens`, `oauth_link_verifications`, `sms_auth_challenges` (`app/repositories/auth/*`, сервіси auth): чи впливає на відповідь або throttle наявність простроченого чи використаного рядка (відповідь «вже використано» проти «недійсне», лічильники resend, `resend_available_at`, пошук останнього челенджу за телефоном).
- [ ] Результат — таблиця в `progress.md`: таблиця → читання → чи залежить від старого рядка → мінімальний безпечний retention. Підтвердити або змінити `AUTH_TOKEN_RETENTION = 7d`; якщо значення змінюється, оновити план.

### T15 · Міграція індексів

- [ ] `database/schema.ts`: `index('<table>_expires_at_idx').on(table.expiresAt)` для чотирьох таблиць без нього; міграція через `drizzle-kit generate` (формат 1.0, папка на міграцію).
- [ ] `make test-pg`: міграція застосовується на чистій БД; `EXPLAIN` запиту видалення використовує індекс (перевірка в тесті або в `progress.md`).

### T16 · Репозиторії і сервіс

- [ ] У кожному з п'яти репозиторіїв: `deleteExpiredBatch(before, limit): Promise<number>` (`DELETE … WHERE id IN (SELECT id … WHERE expires_at < $1 ORDER BY id LIMIT $2)`) і `countExpired(before): Promise<number>`; експорт через barrel.
- [ ] `app/services/auth/auth-token-cleanup-service.ts`: `purgeExpired({ before, dryRun, checkpoint }): Promise<JobResult>` — по таблицях, пачками по 1000, `checkpoint()` безпосередньо перед кожним запитом, поки пачка повна.
- [ ] `config/auth.ts` (або окремий модуль): `AUTH_TOKEN_RETENTION` через `parseScheduleDuration`-подібну валідацію; `.env.example`.

### T17 · Задача і тести

- [ ] `app/scheduler/jobs/auth-token-cleanup.ts`: `{ dailyAt: '03:30' }`, `timeout: '10m'`, `before = now − retention`; додати в реєстр.
- [ ] `auth-token-cleanup.pg.test.ts`: видаляються лише рядки з `expires_at < now − retention` у всіх п'яти таблицях; ще дійсні й нещодавно прострочені лишаються; цикл пачок (`batchSize` малий у тесті); `checkpoint`, що кидає після першої пачки, — наступний запит не виконується; `dryRun` нічого не змінює і рахує ті самі рядки; **два одночасні запуски** (`race-barrier.ts`) видаляють кожен рядок рівно один раз і не падають.
- [ ] Юніт задачі: обчислення `before`, передача `checkpoint`/`dryRun`.

### T18 · Документація і закриття

- [ ] `documentation/backend/database.md` і `auth.md` (обидві локалі): індекси, retention, задача; `configuration.md` — `AUTH_TOKEN_RETENTION`; сторінка планувальника — задача в списку.
- [ ] Ручна перевірка: `job:run auth-token-cleanup --dry-run` на локальній БД з тестовими простроченими рядками, потім без `--dry-run`; числа збігаються.
- [ ] Evidence, `review`, merge, «Mark feat-223 done».

---

## feat-224 · Retention промптів LLM

### T19 · Старт фічі

- [ ] PR до `main`: `feat-224` → `in_progress` (після `feat-222` = `done`); гілка `feat/llm-prompt-retention-job`, `feature-state/feat-224/`; `./init.sh`.

### T20 · Скасування в наявній чистці

- [ ] `app/repositories/ai/usage/llm-usage-repository.ts` `purgePromptText({ olderThan, dryRun, batchSize, checkpoint = noCheckpoint })`: `checkpoint()` безпосередньо перед вибіркою сторінки і перед підрахунком/`UPDATE`; результат `{ matched, changed }` (`changed` = 0 при `dryRun`).
- [ ] `llm-usage-service.ts` — передає `checkpoint`; оновити тип і всі виклики.
- [ ] `usage-audit.pg.test.ts` або новий `llm-prompt-purge.pg.test.ts`: `checkpoint`, що кидає після першої сторінки, — наступний запит не виконується, решта рядків незмінна; два одночасні запуски дають той самий кінцевий стан, що й один; `matched`/`changed` для `dryRun` і без нього.

### T21 · Задача

- [ ] `app/scheduler/jobs/llm-prompt-retention.ts`: `{ dailyAt: '04:00' }`, `timeout: '10m'`; план — наявна `planPurge` з `scripts/purge-llm-prompts-args.ts` без `--all` (за потреби перенести `planPurge` у `services/ai/usage/`, щоб задача не імпортувала `scripts/`); передає `ctx.checkpoint`/`ctx.dryRun`; реєстр.
- [ ] Юніт: план за `AI_USAGE_STORE_PROMPTS=false` (усе) і `true` (`AI_USAGE_PROMPT_RETENTION_DAYS`); PG-тест задачі на реальній таблиці.

### T22 · CLI через спільний lease

- [ ] `scripts/purge-llm-prompts.ts`: `withJobLease('llm-prompt-retention', …)` з `leaseForJob`, прапори `--all`/`--days`/`--dry-run` без змін, SIGINT → abort, «зайнято» → код 75, вивід `matched`/`changed`; закриває Redis.
- [ ] `purge-llm-prompts-args.spec.ts` — без регресій; Redis-тест: CLI під час планового запуску → 75.

### T23 · Документація і закриття

- [ ] `documentation/backend/ai.md` і `en/backend/ai.md`: «запускайте з cron» → опис задачі `llm-prompt-retention`; CLI тепер потребує Redis і поважає lease; сторінка планувальника — задача в списку.
- [ ] Ручна перевірка: `llm:purge-prompts --dry-run` і `job:run llm-prompt-retention --dry-run` дають однакові `matched`.
- [ ] Evidence, `review`, merge, «Mark feat-224 done».
