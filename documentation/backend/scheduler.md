# Фонові задачі

Бекенд запускає задачі обслуговування за розкладом усередині процесу `app`. Поки lease-ключ задачі не втрачено з Redis, задача не виконується паралельно сама з собою, скільки б реплік `app` не працювало. Розклад живе в коді, поруч із задачами, і покритий тестами. Задум і рішення — у внутрішньому плані `docs/plan/scheduler-plan.md` (Р1–Р13). Код: [`app/scheduler/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/scheduler).

## Задачі

| Задача               | Розклад (UTC)          | Timeout | Що робить                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-token-cleanup` | `{ dailyAt: '03:30' }` | `10m`   | Видаляє одноразові токени і SMS-челенджі, у яких `expires_at` раніше за `now − AUTH_TOKEN_RETENTION` (за замовчуванням `7d`), пачками по 1000 ([`auth-token-cleanup.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/auth-token-cleanup.ts)). Див. [Автентифікація](/backend/auth#чистка-прострочених-токенів). |

::: warning План
Retention промптів LLM (`feat-224`) з'явиться окремою фічею.
:::

## Як це працює

- **Один цикл на процес.** Кожні `SCHEDULER_TICK` (за замовчуванням `30s`, кожне очікування відхиляється на ±20 %, щоб репліки не билися за lease щосекунди) планувальник обходить реєстр по порядку і виконує щонайбільше одну задачу за раз. Різні задачі все одно можуть одночасно виконуватися на різних репліках.
- **Lease на задачу.** Запуск бере `sched:lease:<job>` через [`withJobLease`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/job-lease.ts) — оренду поверх [`redis-lease.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/redis-lease.ts), яка сама продовжується, поки задача працює. Репліка, що застала його зайнятим, пропускає задачу (`skipped-locked`). Без Redis немає lease, і жодна задача не стартує (fail-closed); тік пропускається з одним `warn`.
- **Стан** — hash `sched:state:<job>`: `lastSuccessSlot`, `consecutiveFailures`, `nextRetryAt`, `lastRunAt`, `lastOutcome`, `lastDurationMs`. Він читається після взяття lease, а кожен запис — один Lua-скрипт, який спершу перевіряє, що lease досі належить тому, хто пише, тож колишній власник не перезапише стан нового.
- **Процес `app`.** `index.ts` запускає планувальник після того, як сервер почав слухати (за `SCHEDULER_ENABLED`), і зупиняє його до закриття пулів і Redis. `/ready` від нього не залежить.

## Розклади

Типізовані, без рядкового DSL ([`schedule.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/schedule.ts)):

| Розклад                | Слоти                                                                                               | Обмеження                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `{ every: '15m' }`     | Сітка UTC від епохи, `floor(now / interval) * interval`: `15m` дає :00/:15/:30/:45 на всіх репліках | Ціле число хвилин, щонайменше `1m`; доба ділиться на нього (не `7m`) |
| `{ dailyAt: '03:00' }` | Сьогоднішній `HH:MM` UTC, якщо він уже настав, інакше вчорашній                                     | `HH:MM` від `00:00` до `23:59`                                       |

Тижневі розклади і cron-синтаксис не підтримуються.

## Гарантії

- **Запускається останній актуальний слот.** Задача «due», якщо `lastSuccessSlot < currentSlot` і `now ≥ nextRetryAt`. Пропущені слоти згортаються в один запуск: після триденного простою добова задача виконається один раз, а не тричі. Виконання кожного слоту не гарантується.
- **Перший старт.** Без стану в Redis задача виконується один раз одразу для поточного слоту: для `dailyAt: '03:00'` о 01:00 це вчорашній 03:00, тож чистка не чекає до наступного ранку. Так само поводиться втрачений стан.
- **Невдалий запуск може повторитися.** `failed` і `timeout` збільшують `consecutiveFailures` і ставлять `nextRetryAt = now + min(1m × 2^(failures − 1), maxBackoff)`, де `maxBackoff` — `min(every, 1h)` для `every` і `1h` для `dailyAt`. Backoff спільний для всіх реплік. Успіх його обнуляє. Якщо стан записати не вдалося (Redis не відповів або lease уже не наш), процес тримає той самий backoff локально.
- **Перерваний запуск ніколи не є успіхом.** Якщо на момент завершення `run()` сигнал перерваний або перевірка власника відхилила запис успіху, `lastSuccessSlot` не записується, навіть коли `run()` повернув результат.

### Межі гарантій

- **Redis недоступний.** Задачі не стартують; процес працює далі. Задача, що виконується, дізнається про втрату через дедлайн lease, і наступний `checkpoint()` зупиняє її перед SQL-кроком.
- **Втрачено лише стан** (`sched:state:*`). Кожна задача виконається один раз одразу, як на першому старті, а backoff обнулиться. Перекриття немає: lease-ключі живі.
- **Втрачено lease-ключ** (`FLUSHALL`/`FLUSHDB`, failover на репліку без ключа, витіснення). Інша репліка може взяти новий lease, поки старий власник ще виконує SQL: **два запуски тієї самої задачі можуть перекритися**. Старий власник дізнається про це на наступному продовженні, і його наступний `checkpoint()` зупиняє задачу; його записи стану відхиляються. Тому кожна задача мусить бути **безпечною для одночасного запуску двох копій**, а не лише ідемпотентною. Redis застосунку мусить працювати з `maxmemory-policy noeviction`: за політики `volatile-*` чи `allkeys-*` lease-ключ можна витіснити.
- **БД змінено, а успіх не записано.** Слот лишається «due», задача виконається ще раз; для чистки це no-op.
- **Розклад змінився між версіями.** Новий поточний слот порівнюється з `lastSuccessSlot`, тож можливий додатковий запуск (перехід на рідший розклад від цього не захищає). Перейменована задача отримує новий стан і виконується як на першому старті; старий ключ `sched:state:<old>` лишається до ручного видалення.
- **Тривале блокування event loop.** Поки цикл подій заблоковано, таймери lease не спрацьовують, і ключ може протермінуватися. `checkpoint()` не дає почати новий SQL-крок після локального дедлайну, але не захищає запит, відправлення якого затрималося вже після `checkpoint()`. Межа перекриття не гарантується. Звідси заборона синхронної CPU-важкої роботи в задачах.
- **Годинники.** Слоти й `nextRetryAt` рахуються за `Date.now()` кожної репліки; розбіжність на кілька секунд лише зсуває запуск, а дублі слоту відсікає `lastSuccessSlot`.

## Результати і логи

Один запис pino на запуск: `job`, `slot` (ISO), `trigger` (`schedule` / `manual`), `dryRun`, `durationMs`, `matched`, `changed`, `outcome`, `category`.

| `outcome`                           | `category` | Лог, Sentry                               | Стан у Redis                        |
| ----------------------------------- | ---------- | ----------------------------------------- | ----------------------------------- |
| `ok`                                | `success`  | `info`                                    | `lastSuccessSlot`, backoff обнулено |
| `failed`                            | `failure`  | `error`, Sentry з тегами `job`, `outcome` | `consecutiveFailures + 1`, backoff  |
| `timeout`                           | `aborted`  | `error`, Sentry з тегами `job`, `outcome` | `consecutiveFailures + 1`, backoff  |
| `lease-lost`                        | `aborted`  | `warn`                                    | без змін                            |
| `shutdown`                          | `aborted`  | `info`                                    | без змін                            |
| `skipped-locked`, `skipped-backoff` | `skipped`  | `info`                                    | без змін                            |

## Зупинка

`scheduler.stop()` (зі `stopHandler` в `index.ts`, до зупинки сервера і пулів):

1. нових запусків не починає;
2. перериває поточну задачу (`outcome: shutdown`);
3. чекає її до drain (5 с). Якщо задача завершилася, lease звільняється. Якщо ні, SQL ще може виконуватися (один запит на основному пулі за замовчуванням триває до 12,5 с), тому lease **покидається** (`abandon()`): продовження зупиняються, але ключ живе до свого TTL, і жодна інша репліка не стартує посеред цього SQL. Lease задачі розраховано так, що після будь-якого пройденого `checkpoint()` ключ живе ще щонайменше найдовший запис у БД плюс секунду.

Помилка Redis під час звільнення чи `abandon()` логується як `warn` і не обриває решту shutdown.

## Як додати задачу

1. Оформіть роботу як метод **сервісу**: задачі викликають сервіси, як контролери, і ніколи не імпортують репозиторії (це перевіряє `layering.spec.ts`). Метод приймає `checkpoint` ([`Checkpoint`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/checkpoint.ts), поза задачами — `noCheckpoint`) і повертає [`PurgeCounts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/purge-counts.ts) (`{ matched, changed }`, при dry run `changed` = 0).
2. Опишіть задачу через [`defineJob`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/job.ts) у `app/scheduler/jobs/<name>.ts` і додайте її до реєстру в [`jobs/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/scheduler/jobs/index.ts):

```ts
import { defineJob } from '../job.js'
import { exampleCleanupService } from '#app/services/example/example-cleanup-service.js'

export const exampleCleanupJob = defineJob({
    name: 'example-cleanup', // kebab-case, унікальне: частина ключів Redis
    schedule: { dailyAt: '03:30' },
    timeout: '10m',
    run: (ctx) =>
        exampleCleanupService.purge({
            before: new Date(Date.now() - 7 * 86_400_000),
            dryRun: ctx.dryRun,
            checkpoint: ctx.checkpoint,
        }),
})
```

Контракт `ctx` (`{ signal, checkpoint, slot, dryRun, logger }`):

- **`checkpoint()` безпосередньо перед кожним SQL-кроком**, без `await` між викликом і запитом, і передається аж до циклу, що робить роботу. Він кидає, якщо сигнал перерваний (timeout, втрата lease, shutdown) або минув локальний дедлайн lease. Задача, що його не передає, після abort працює далі і тримає lease до TTL.
- `signal` — для очікувань, що приймають `AbortSignal`.
- Задача **ідемпотентна** (невдалий запуск повторюється) і **безпечна для двох одночасних копій** (див. межі вище): видаляйте чи оновлюйте пачками `… WHERE id IN (SELECT … LIMIT n)`, ніколи не «прочитати, потім записати» без умови.
- Без синхронної CPU-важкої роботи: вона блокує event loop uWS і таймери lease.
- Тест, що `checkpoint`, який кидає після першої пачки, зупиняє до наступного запиту, і тест двох одночасних запусків.

## Ручний запуск

```sh
pnpm --filter backend job:run <name> [--dry-run]
```

[`scripts/run-job.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts/run-job.ts) бере той самий lease, що й плановий запуск, тож вони ніколи не працюють поруч, і виводить `matched` і `changed` (при `--dry-run` `changed` = 0). Стан розкладу (`lastSuccessSlot`, backoff) він не змінює і потребує Redis. Задача, вимкнена для розкладу (`SCHEDULER_DISABLED_JOBS`), вручну все одно запускається, з попередженням.

`pnpm` перетворює будь-який ненульовий код виходу на `1`. Де важливий точний код (обгортка cron, що повторює на `75`), запускайте сам скрипт: `pnpm --filter backend exec tsx src/scripts/run-job.ts <name>` у розробці, `node dist/scripts/run-job.js <name>` у зібраному образі.

| Код виходу | Значення                                                              |
| ---------- | --------------------------------------------------------------------- |
| `0`        | `ok`                                                                  |
| `1`        | `failed`, `timeout`, `lease-lost` або неправильний аргумент           |
| `75`       | зайнято: задача виконується деінде (`EX_TEMPFAIL`), спробуйте пізніше |
| `130`      | перервано (SIGINT/SIGTERM)                                            |

## Змінні

| Змінна                    | За замовчуванням | Опис                                                                                   |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `SCHEDULER_ENABLED`       | `true`           | Чи запускає цей процес планувальник; `false` вимикає його на репліці.                  |
| `SCHEDULER_TICK`          | `30s`            | Як часто перевіряються задачі: тривалість від `5s` до `5m`.                            |
| `SCHEDULER_DISABLED_JOBS` | порожньо         | Імена задач через кому, які розклад пропускає. Невідоме ім'я зупиняє старт (опечатка). |

Їх читає [`config/scheduler.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/scheduler.ts); недійсне значення — помилка старту `Invalid scheduler configuration: ...`. Див. також [Конфігурація](/backend/configuration#фонові-задачі).
