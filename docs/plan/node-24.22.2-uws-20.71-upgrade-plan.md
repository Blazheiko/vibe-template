# План оновлення: Node.js 24.22.2 + µWebSockets.js v20.71.0 + залежності

- **Дата зрізу версій:** 2026-10-31 (`pnpm outdated -r`, `npm view`, `git ls-remote` uWS).
- **Ціль:** основний результат — Node 24.22.2 і uWS v20.71.0 з доведеною сумісністю транспорту. Решта оновлень — незалежні рішення з власними доказами сумісності, кожне в окремому PR.
- **Принцип:** точні версії з таблиць нижче. Якщо під час виконання вийшли новіші — оновлюємо таблицю окремим комітом, а не підставляємо «latest» мовчки.
- **Ревізія 5:** перевірка заголовків через GET, явний перезапуск backend після додавання і видалення тимчасового логування, видалення лише рядка логування замість `git checkout` файлу, `pnpm build` з кореня.
- **Ревізія 4:** виконуваність B.4 — тестовий файл `packages/backend/public/bench-8m.mp4` (allowlist, створюється до старту), точна команда запуску з `bench.env` і `SERVE_STATIC=true`, хеш повільного завантаження з файлу, розділено unit-доказ (наявна спека) і runtime-доказ виклику `onWritable` у новому аддоні.
- **Ревізія 3:** benchmark-конфігурація лімітів і перевірка валідності прогонів (2xx, handshake, доставка), `wrk --latency`, файл строго більший за поріг RAM-кешу і окрема перевірка backpressure повільним читачем, `REDIS_TEST_URL`, `format:check` і `build` у протоколі приймання.
- **Ревізія 2:** враховано рев'ю — транспортний бенчмарк замість `bench:response`, відтворювана Docker-перевірка (linux/amd64, точна версія Node), повний перелік точок інтеграції uWS, протокол приймання з кількістю виконаних/пропущених тестів, окремі оцінки сумісності Drizzle rc.5 і Mermaid 12.
- Попередній план: [`dependency-upgrade-plan.md`](./dependency-upgrade-plan.md).

## 0. Вихідний стан і розбиття на PR

| Що                | Зараз                                        | Ціль                  |
| ----------------- | -------------------------------------------- | --------------------- |
| Node.js           | `.nvmrc` `24.22.1`, `engines ^24.22.1`       | `24.22.2`, `^24.22.2` |
| uWebSockets.js    | `github:uNetworking/uWebSockets.js#v20.56.0` | `#v20.71.0`           |
| pnpm              | `packageManager: pnpm@9.15.0`                | без змін (див. §7)    |
| Машина розробника | darwin-arm64, Node `v24.22.2`, є `wrk`       | —                     |

| PR  | Гілка                          | Зміст                           | Залежить від |
| --- | ------------------------------ | ------------------------------- | ------------ |
| 1   | `chore/node-24.22.2-uws-20.71` | Етапи A, B (основний результат) | —            |
| 2   | `chore/deps-patch-minor`       | Етап C                          | PR 1         |
| 3   | `chore/mistral-v3`             | D.1                             | PR 2         |
| 4   | `chore/drizzle-rc5`            | D.2                             | PR 2         |
| 5   | `chore/mermaid-12`             | D.3                             | —            |

Кожен PR — окремий запис у `feature_list.json` (через PR на `main`) зі своїм `progress.md` і блоком Evidence.

## 1. Етап A — Node.js 24.22.2

Patch у межах 24 LTS, ризик низький.

- [ ] `.nvmrc`: `24.22.2` (CI бере версію з нього: `ci.yml`, `docs.yml`, `redis-tests.yml`, `pg-tests.yml`).
- [ ] `package.json` і `packages/api-playground/package.json`: `"node": "^24.22.2"`.
- [ ] `Dockerfile` — зробити версію Node відтворюваною. Зараз обидва етапи (`builder`, рядок 8; `production`, рядок 67) ставлять рухому `setup_24.x`, тож збірка не гарантує 24.22.2:
    - додати `ARG NODE_VERSION=24.22.2` і встановлювати `nodejs=${NODE_VERSION}-1nodesource1` в обох етапах;
    - після встановлення в обох етапах: `RUN test "$(node -v)" = "v${NODE_VERSION}"` — збірка падає при розбіжності.
- [ ] Документація (усі згадки `24.22.1`): `AGENTS.md:58`, `README.md:85,393`, `documentation/guide/introduction.md:39`, `documentation/guide/getting-started.md:9`, `documentation/guide/project-structure.md:78`, `documentation/reference/toolchain.md:9,22` (додати, що Docker пінить ту саму версію), `docs/requirements/operations/template-constraints-assumptions.md:9`.
- [ ] Перевірка: `rg "24\.22\.1" --glob '!pnpm-lock.yaml'` → порожньо.

## 2. Етап B — µWebSockets.js v20.56.0 → v20.71.0

uWS — нативний аддон із prebuilt-бінарниками під конкретні платформу й ABI Node. Ризики: відсутній бінарник для потрібної пари платформа/ABI і зміни семантики backpressure та життєвого циклу з'єднання.

### B.0 Базові вимірювання (до будь-яких змін)

На `main` (uWS v20.56.0, Node 24.22.2), до зміни версії:

- [ ] Записати базові результати транспортного бенчмарку (B.4) і кількість тестів за протоколом §6 у `progress.md` → «Baseline». Без цього порівняння в B.4 недійсне.

### B.1 Аналіз змін

- [ ] Release notes v20.57.0 … v20.71.0 (GitHub Releases `uNetworking/uWebSockets.js`) і `git diff v20.56.0 v20.71.0 -- index.d.ts docs/` у клоні. Зафіксувати в `progress.md`:
    - `HttpResponse`: `cork`, `onAborted`, `onData`/`onDataV2`, `onWritable`, `tryEnd`, `getWriteOffset`, `close`, `endWithoutBody`, `getRemoteAddressAsText`;
    - `WebSocketBehavior`: `upgrade`, `maxPayloadLength`, `idleTimeout`, `sendPingsAutomatically`, `maxBackpressure`, `closeOnBackpressureLimit`, `drain`;
    - pub/sub: `publish`, `subscribe`, `numSubscribers`;
    - список підтримуваних версій Node і платформ prebuilt-бінарників (обов'язково: darwin-arm64, linux-x64).

### B.2 Зміни в коді

- [ ] `packages/backend/package.json`: `"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.71.0"`; `pnpm install`; закомітити `pnpm-lock.yaml`.
- [ ] Перевірити й за потреби адаптувати всі точки інтеграції:

| Файл                                                                 | Що чутливе до змін                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/backend/src/vendor/start/server.ts`                        | створення App, WS-поведінка, broadcast/pub-sub                                                     |
| `packages/backend/src/vendor/start/static-server.ts`                 | streaming файлів (`:290`): `tryEnd` → `onWritable`, `cork`, `onAborted`, `close` — backpressure    |
| `packages/backend/src/vendor/utils/network/ws-handlers.ts`           | WS upgrade (`:413` `onAborted`, `:497` `res.upgrade`), upgrade rate limit, життєвий цикл з'єднання |
| `packages/backend/src/vendor/utils/network/http-request-handlers.ts` | читання тіла (`onData`), aborted, cork, ліміти тіла                                                |
| `packages/backend/src/app/validate/checkers/header-checker.ts`       | читання заголовків `HttpRequest`                                                                   |
| `packages/backend/src/vendor/types/types.d.ts`                       | власні типи поверх uWS                                                                             |

- [ ] Транспортні спеки (`src/vendor/start/*.spec.ts`) мають пройти без зміни очікувань. Будь-яка зміна очікування = зміна поведінки: окремий коміт з поясненням.
- [ ] `documentation/backend/index.md:15`: `v20.56.0` → `v20.71.0`.

### B.3 Перевірка платформ

- [ ] darwin-arm64: `pnpm --filter backend build && pnpm --filter backend start` — сервер стартує, немає помилки `This version of uWS.js supports only Node.js ...`.
- [ ] linux-x64 (цільова для Docker/CI): на arm64-машині `docker build .` збирає linux-arm64, тому явно:

```bash
docker buildx build --platform linux/amd64 -t vibe:uws-check --load .
docker run --rm --platform linux/amd64 vibe:uws-check node -v           # v24.22.2
docker run --rm --platform linux/amd64 vibe:uws-check \
  node -e "import('uWebSockets.js').then(() => console.log('uws ok'))"
```

- [ ] Опційно linux/arm64 тим самим способом, якщо образ планується для ARM-хостів.
- [ ] Запуск контейнера linux/amd64 з `.env` і ручний golden path (B.5) проти нього.

Емуляція amd64 на arm64 (QEMU) підходить для перевірки завантаження бінарника, але не для вимірювання продуктивності.

### B.4 Транспортний бенчмарк

`bench:response` (`src/scripts/bench-response-check.ts`) вимірює лише валідацію й серіалізацію в процесі, без HTTP/WS. Для uWS він не показовий і в цьому етапі не використовується як критерій.

Умови (однакові для baseline і для нової версії): та сама машина, нативний darwin-arm64 (не Docker/QEMU), живлення від мережі, без інших навантажень; `NODE_ENV=production`, `pnpm --filter backend build && pnpm --filter backend start`; прогрів 10 с; 3 прогони по 30 с; порівнюємо медіану.

**Benchmark-конфігурація лімітів.** Усе навантаження йде з одного IP, а за замовчуванням діють обмежувачі: HTTP — 600 запитів/хв (`src/config/rate-limit.ts:36`), WS upgrade — 120/хв локально (`rate-limit.ts:41`) і 60/хв спільний через Redis (`src/config/throttle-policies.ts:184`). Без зміни лімітів бенчмарк вимірює обмежувачі, а не транспорт. Для baseline і нової версії — однаковий файл `bench.env` (у scratchpad, не в репозиторії):

```bash
HTTP_GLOBAL_RATE_LIMIT_MAX=100000000
WS_UPGRADE_RATE_LIMIT_MAX=100000000
WS_UPGRADE_SHARED_RATE_LIMIT_MAX=0        # disableable: true — політику вимкнено
STATIC_MAX_MEMORY_FILE_SIZE=1048576       # фіксуємо поріг явно (default)
SERVE_STATIC=true                         # static за замовчуванням вимкнений (src/config/app.ts:69)
NODE_ENV=production
```

Вміст `bench.env` — у `progress.md` поруч із результатами. Ліміти перевіряються окремо спеками `rate-limit.transport.spec.ts`, `server-rate-limit.spec.ts`, а не бенчмарком.

**Підготовка і запуск** (однаково для baseline і нової версії). Static-server читає `public/` від робочого каталогу backend (`static-server.ts:18`) і кешує лише файли з allowlist розширень (`static-server.ts:136`; `.bin` там немає, `.mp4` є). Індекс static будується під час старту, тому файл має існувати до запуску:

```bash
SCRATCH=/private/tmp/claude-501/.../scratchpad   # повний шлях до scratchpad сесії
pnpm build                                       # з кореня репозиторію: shared + backend
cd packages/backend
head -c 8388608 /dev/urandom > public/bench-8m.mp4   # не комітимо; видалити після прогонів
shasum -a 256 public/bench-8m.mp4 > "$SCRATCH/bench-8m.sha256"
# Змінні з bench.env потрапляють у process.env до старту; dotenv/config (src/index.ts:1)
# не перезаписує вже задані змінні, решта береться з .env.
set -a; . "$SCRATCH/bench.env"; set +a
node dist/index.js
```

- [ ] Перед прогонами переконатися, що конфіг застосовано: `curl -sS -D - -o /dev/null http://127.0.0.1:<PORT>/bench-8m.mp4` → `200` (саме GET: static-маршрути зареєстровані через `server.get`, `server.ts:650`, а fallback обслуговує static лише для `method === 'get'`, `server.ts:705`), `Content-Length: 8388608`; 700 швидких запитів на API-маршрут не дають жодного `429`.
- [ ] Після прогонів: `rm packages/backend/public/bench-8m.mp4`, `git status` чистий.

- [ ] HTTP, легкий маршрут: `wrk -t4 -c100 -d30s --latency http://127.0.0.1:<PORT>/<health-або-публічний-GET>` — req/s і p99 з розподілу `--latency`. Валідність прогону: `Non-2xx or 3xx responses` відсутній і `Socket errors` = 0; інакше прогін недійсний (найімовірніше, спрацював обмежувач).
- [ ] HTTP, streaming зі диску: файл **строго більший** за `STATIC_MAX_MEMORY_FILE_SIZE` (файли ≤ 1 048 576 байт обслуговуються з RAM, `static-server.ts:145`), тут `public/bench-8m.mp4` (8 МБ, див. «Підготовка»). `wrk -t4 -c50 -d30s --latency http://127.0.0.1:<PORT>/bench-8m.mp4` — пропускна здатність (МБ/с) і p99; валідність — як вище. Цілісність: `curl -s http://127.0.0.1:<PORT>/bench-8m.mp4 | shasum -a 256` збігається з `$SCRATCH/bench-8m.sha256`.
- [ ] Backpressure (`onWritable`, `static-server.ts:348`) — два різні докази, потрібні обидва:
    - **Unit (наш алгоритм):** наявна спека `static-server-caching.spec.ts:178` (streaming з диску з мок-`HttpResponse`) зелена. Вона не доводить сумісності з новим аддоном.
    - **Runtime (новий uWS):** повільний читач зберігає результат у файл, щоб перевірити саме це завантаження:

        ```bash
        curl -s --limit-rate 100k -o "$SCRATCH/slow.mp4" http://127.0.0.1:<PORT>/bench-8m.mp4
        shasum -a 256 "$SCRATCH/slow.mp4"   # = bench-8m.sha256; розмір 8388608
        ```

        RSS процесу під час завантаження не росте на розмір файлу (`ps -o rss= -p <pid>` до/під час/після). Виклик `onWritable` підтверджуємо тимчасовим локальним патчем (не комітимо), окремим прогоном до заміру продуктивності:
        1. Усі потрібні адаптації `static-server.ts` під новий uWS уже закомічені (`git diff -- packages/backend/src/vendor/start/static-server.ts` порожній).
        2. Додати лише рядок `logger.info('bench:onWritable')` на початку колбека `res.onWritable(...)`.
        3. Зупинити backend, `pnpm --filter backend build`, **запустити backend знову** (`node dist/index.js` без watch — перезбірка не потрапляє в запущений процес).
        4. Повільне завантаження вище; у лозі ≥ 1 рядок `bench:onWritable`.
        5. Видалити лише цей рядок (`git diff` знову порожній — не `git checkout` всього файлу без п. 1), зупинити backend, перезібрати, **перезапустити**, і тільки тоді заміри продуктивності.

        Той самий патч — для baseline і для нової версії. 0 викликів = backpressure не перевірено, прогін повторити з меншим `--limit-rate`.
- [ ] WS: скрипт у scratchpad (не в репозиторії) на N=500 з'єднань. Міряємо час встановлення всіх з'єднань і пропускну здатність broadcast. Валідність: усі 500 handshake успішні (HTTP 101, немає `429`/close-кодів), кожен клієнт отримав усі M broadcast-повідомлень (лічильник отриманих = N×M, без втрат і дублікатів).
- [ ] Критерій: req/s, МБ/с і пропускна здатність WS не нижчі за baseline більше ніж на 5%, p99 не вищий більше ніж на 10%. Якщо розкид між прогонами > 5%, спершу стабілізуємо умови, а не робимо висновок.
- [ ] Результати (baseline і нова версія, команди, `bench.env`, умови, лічильники валідності) — у `progress.md`.

### B.5 Ручний golden path проти реального backend

Звичайний `test:e2e` піднімає Vite (`playwright.config.ts:93`) і не перевіряє uWS. Тому:

- [ ] `pnpm --filter frontend test:e2e:security` — Playwright проти зібраного prod-сервера (`scripts/prod-local.sh`, `playwright.security.config.ts:30`). Це автоматизований прогін через новий uWS.
- [ ] Вручну на `pnpm prod:local`: login → HTTP-запити → WS-підключення → broadcast отримано → перезавантаження сторінки (reconnect) → закриття вкладки (з'єднання закрито на сервері, без помилок у логах).
- [ ] Великий upload (близько ліміту тіла і понад ліміт → 413) і обрив завантаження великого статичного файлу (сервер не падає, немає записів після abort).

## 3. Етап C — patch/minor оновлення (PR 2)

Одним комітом, якщо протокол §6 зелений; інакше розбиваємо по пакетах.

| Пакет                           | Зараз    | Ціль     | Де                                |
| ------------------------------- | -------- | -------- | --------------------------------- |
| `@ai-sdk/xai`                   | 5.0.24   | 5.0.35   | backend                           |
| `ai`                            | 7.0.143  | 7.0.159  | backend                           |
| `@arktype/type`                 | 2.2.8    | 2.2.9    | backend, shared (разом)           |
| `@ark/util`                     | 0.56.7   | 0.56.8   | shared                            |
| `@aws-sdk/client-s3`            | 3.1152.0 | 3.1161.0 | backend (разом з presigner)       |
| `@aws-sdk/s3-request-presigner` | 3.1152.0 | 3.1161.0 | backend                           |
| `@sentry/node`                  | 11.8.0   | 11.10.0  | backend (разом з `@sentry/vue`)   |
| `@sentry/vue`                   | 11.8.0   | 11.10.0  | frontend                          |
| `dotenv`                        | 18.0.8   | 18.0.9   | backend                           |
| `nodemailer`                    | 10.1.2   | 10.3.1   | backend                           |
| `openai`                        | 7.36.0   | 7.47.0   | backend                           |
| `vue-i18n`                      | 11.4.15  | 11.4.16  | frontend                          |
| `eslint`                        | 10.13.0  | 10.14.0  | root                              |
| `typescript-eslint`             | 8.71.2   | 8.72.1   | root + **усі 4 `pnpm.overrides`** |
| `eslint-plugin-vue`             | ~10.11.1 | ~10.12.0 | frontend, api-playground          |
| `@vitest/eslint-plugin`         | 1.6.27   | 1.6.28   | frontend                          |
| `vue-tsc`                       | 3.3.13   | 3.3.14   | frontend, api-playground          |
| `npm-run-all2`                  | 9.0.3    | 9.0.4    | frontend, api-playground          |
| `autoprefixer`                  | 10.6.1   | 10.6.2   | api-playground                    |
| `postcss`                       | 8.5.30   | 8.5.32   | api-playground                    |
| `node-html-parser`              | 9.0.5    | 9.0.6    | documentation                     |

- Backend пінить точні версії (без `^`) — зберігаємо стиль.
- `openai` (+11 minor), `nodemailer` (+2 minor): переглянути changelog; тести AI-адаптерів, `pnpm --filter backend mail:test` з тестовим SMTP.
- `@aws-sdk/*`: тести S3 зелені не доводять роботу з реальним bucket — ручне завантаження/presigned URL на тестовому bucket (або MinIO локально).
- `typescript-eslint` і `pnpm.overrides` — в одному коміті; `pnpm why @typescript-eslint/utils` показує одну версію.

## 4. Етап D — незалежні мажорні рішення

Кожне — окремий PR з власними доказами сумісності. Відмова від оновлення — валідний результат, якщо записана причина.

### D.1 `@mistralai/mistralai` 2.7.0 → 3.4.0 (PR 3)

- [ ] Changelog/migration guide v3: зміни клієнта, chat API, обробки помилок, `AbortSignal`, usage-полів.
- [ ] Адаптувати `services/ai/adapters/mistralai-text-adapter.ts`, `ai-provider.ts`, `config/ai.ts`.
- [ ] Тести: `adapter-signal.spec.ts`, `usage-recording.spec.ts` — без зміни очікувань.
- [ ] Ручна перевірка з реальним ключем (або `Not-tested: requires Mistral API key` у коміті): відповідь, скасування запиту, облік usage.

### D.2 Drizzle `1.0.0-rc.4` → `1.0.0-rc.5` (PR 4)

Відсутність нових міграцій не доводить збереження поведінки запитів.

- [ ] Виписати breaking changes rc.5 з https://github.com/drizzle-team/drizzle-orm/releases і для кожного знайти використання в коді (`rg` по `packages/backend/src`): RQB v2 (`defineRelations`, `relations.ts`), типи результатів, `casing`, мігратор, codecs/типи колонок (pgvector), `drizzle-kit` CLI/config.
- [ ] Оновити `drizzle-orm` і `drizzle-kit` разом на одну точну версію.
- [ ] `pnpm --filter backend db:generate` — нових файлів немає (необхідна, але не достатня умова).
- [ ] `PG_TEST_URL=... pnpm --filter backend test:pg` — з кількістю виконаних тестів (§6); 0 виконаних = перевірка не відбулася.
- [ ] На свіжій БД: `db:create` → `db:migrate` → `db:seed` → golden path з етапу B.5.
- [ ] Якщо зачеплено breaking change без покриття `*.pg.test.ts` — дописати тест до оновлення, щоб він фіксував поточну поведінку.

### D.3 `mermaid` 11.17.2 → 12.2.0 (PR 5)

`docs:verify` (`documentation/scripts/verify-dist.mjs:186`) перевіряє лише наявність контейнерів діаграм, а не рендер.

- [ ] Changelog v12: синтаксис діаграм, API ініціалізації, сумісність з VitePress-плагіном.
- [ ] `pnpm docs:build && pnpm docs:verify`.
- [ ] `pnpm docs:preview` і перевірка в браузері кожної сторінки з діаграмами (`rg -l '```mermaid' documentation`): діаграма відрендерена як SVG, немає `Syntax error` і помилок у консолі, світла і темна тема. Скріншоти — у PR.

### Не оновлюємо в цьому плані

| Пакет         | Зараз   | Latest     | Причина                                                                 |
| ------------- | ------- | ---------- | ----------------------------------------------------------------------- |
| `@types/node` | 24.19.2 | 26.6.6     | Типи мають відповідати рантайму Node 24; 24.19.2 — остання 24.x         |
| `typescript`  | 6.0.3   | 7.0.2      | Окрема фіча (vue-tsc, typescript-eslint); `AGENTS.md` вимагає пін 6.0.3 |
| `vite`        | 7.3.7   | 8.3.5      | Окрема фіча: Rolldown, плагіни, SW-збірка, e2e                          |
| `tailwindcss` | 3.4.19  | 4.3.3      | Окрема фіча (api-playground): CSS-first конфіг                          |
| `arctic`      | 3.7.0   | deprecated | Працює; пошук заміни для `oauth-service.ts` — окрема фіча               |

## 5. Етап E — lockfile і аудит (кожен PR)

- [ ] `pnpm-lock.yaml` закомічено в тому ж PR, що його змінив.
- [ ] `pnpm audit` до/після — у `progress.md`.
- [ ] Після PR 1–5: `pnpm outdated -r` збігається з таблицею «Не оновлюємо».

## 6. Протокол приймання

«Зелено» означає: команда завершилась з кодом 0 **і** кількість виконаних тестів відповідає очікуваній. Пропущені suites не є доказом.

| Перевірка                                  | Умова запуску                                                                                            | Що записати в `progress.md`                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm format:check`                        | завжди (обов'язковий у CI, `ci.yml:41`)                                                                  | код виходу                                              |
| `pnpm typecheck`, `pnpm lint`              | завжди                                                                                                   | код виходу                                              |
| `pnpm build`                               | завжди; критично для PR 2 (frontend/toolchain) — typecheck і unit-тести не перевіряють production bundle | код виходу; для frontend — розмір bundle до/після       |
| `pnpm test`                                | завжди                                                                                                   | passed / skipped / failed по кожному пакету             |
| `pnpm --filter backend test:redis`         | `REDIS_TEST_URL=redis://127.0.0.1:6379` (PR 1)                                                           | passed / skipped; skipped > 0 без причини = не прийнято |
| `pnpm --filter backend test:pg`            | `PG_TEST_URL` з pgvector (PR 1, 4)                                                                       | passed / skipped; аналогічно                            |
| `pnpm --filter frontend test:e2e`          | PR 1, 2                                                                                                  | passed / skipped — перевіряє лише frontend (Vite)       |
| `pnpm --filter frontend test:e2e:security` | PR 1                                                                                                     | passed / skipped — перевіряє реальний uWS-сервер        |
| Транспортний бенчмарк (B.4)                | PR 1                                                                                                     | baseline vs нова версія, умови                          |
| Docker linux/amd64 (B.3)                   | PR 1                                                                                                     | вивід `node -v` і завантаження uWS                      |
| Ручний golden path (B.5)                   | PR 1, 4                                                                                                  | кроки і результат                                       |
| `pnpm docs:build && pnpm docs:verify`      | PR 1, 5 (+ будь-яка зміна docs)                                                                          | код виходу; для PR 5 — скріншоти рендеру                |

Кількість тестів baseline (B.0) порівнюється з кількістю після: зменшення кількості виконаних тестів без пояснення = не прийнято.

## 7. Поза scope

- pnpm 9 → 12 (`packageManager`): змінює формат lockfile і CI.
- TypeScript 7, Vite 8, Tailwind 4, заміна `arctic` — окремі записи в `feature_list.json`.

## 8. Ризики

| Ризик                                                    | Мітигація                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Немає prebuilt-бінарника uWS для платформи/ABI           | B.3: darwin-arm64 нативно + явний `--platform linux/amd64`                 |
| Docker збирає іншу версію Node, ніж перевіряли           | Пін `NODE_VERSION` + `node -v` assert в обох етапах Dockerfile             |
| Зміна семантики backpressure/abort у streaming і WS      | Повний перелік точок у B.2, статичний файл у B.4, обрив завантаження в B.5 |
| Регресія продуктивності транспорту непомічена            | Транспортний бенчмарк з baseline і фіксованими умовами (B.0, B.4)          |
| Інтеграційні suites тихо пропущені                       | Протокол §6: кількість виконаних/пропущених                                |
| Breaking changes Drizzle rc.5 змінюють поведінку запитів | D.2: інвентаризація breaking changes проти коду, `test:pg`, свіжа БД       |
| Mermaid 12 ламає рендер при зеленому `docs:verify`       | D.3: перевірка в браузері + скріншоти                                      |
| Breaking API Mistral SDK v3                              | Окремий PR, ізольований адаптер                                            |

## 9. Definition of Done

Окремо для кожного PR:

- Протокол §6 виконано для відповідного PR, результати в `progress.md` → Evidence of Completion.
- Документація оновлена, `docs:build && docs:verify` зелені.
- Запис у `feature_list.json` → `done` з посиланням на коміт з evidence.

Основний результат (PR 1) прийнято, коли: Node 24.22.2 в `.nvmrc`/`engines`/Docker, uWS v20.71.0 завантажується на darwin-arm64 і linux-x64, транспортний бенчмарк у межах порогів від baseline, `test:e2e:security` і ручний golden path пройдені.
