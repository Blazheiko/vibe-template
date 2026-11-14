# Команди make

[`Makefile`](https://github.com/Blazheiko/vibe-template/blob/main/Makefile) у корені репозиторію — єдина точка входу для операцій розробника. Не треба пам'ятати, яка команда живе в кореневому `package.json`, яка в пакеті (`pnpm --filter backend …`), а яка в `docker compose`: усе запускається як `make <ціль>` з кореня.

`make` без аргументів (або `make help`) виводить усі цілі з описами, згрупованими за розділами.

::: tip Без make
`make` не обов'язковий. Кожна ціль лише викликає pnpm-скрипт, тож усе, зокрема запуск застосунку, можна зробити через `pnpm` напряму: `make dev` — це `pnpm dev`, `make db-migrate` — `pnpm --filter backend db:migrate`, `make app-up` — `pnpm app:up`. Відповідний скрипт для кожної цілі вказано в таблицях нижче, а `make -n <ціль>` друкує команду без запуску. Повний перелік: [Скрипти](/reference/scripts).
:::

## Як це влаштовано

- **Makefile тільки делегує.** Кожна ціль викликає pnpm-скрипт або файл зі [`scripts/`](https://github.com/Blazheiko/vibe-template/tree/main/scripts). Логіки в самому Makefile немає, тому `pnpm <script>` працює так само. Повний перелік скриптів: [Скрипти](/reference/scripts).
- **Опис обов'язковий.** Ціль потрапляє в `make help`, якщо її рядок закінчується на `## опис`; рядок `##@ Назва` відкриває групу.
- **Перевірка шару.** [`scripts/verify-makefile.mjs`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-makefile.mjs) (`make verify-makefile`, входить у `make check`) падає, якщо в цілі немає опису, ціль відсутня в `.PHONY`, рецепт викликає pnpm-скрипт, якого немає в потрібному `package.json`, або файл зі `scripts/`, якого не існує.
- **GNU Make 3.81.** Саме ця версія стоїть на macOS, тому Makefile не використовує `.ONESHELL` і grouped targets. Рецепти відступаються табами, це зафіксовано в [`.editorconfig`](https://github.com/Blazheiko/vibe-template/blob/main/.editorconfig).

## Параметри

| Змінна | Для чого                                              | Приклад                           |
| ------ | ----------------------------------------------------- | --------------------------------- |
| `PKG`  | `make test` для одного пакета (`pnpm --filter <PKG>`) | `make test PKG=backend`           |
| `ARGS` | додаткові аргументи, які передаються скрипту без змін | `make db-seed ARGS=--demo`        |
| `PNPM` | інша команда замість `pnpm`, якщо потрібно            | `make check PNPM="corepack pnpm"` |

`ARGS` підтримують цілі, яким це має сенс: `install`, `prod-local`, `test`, `test-e2e`, `test-pg`, `test-redis`, `services-up`, `db-generate`, `db-seed`, `app-build`. Наприклад, `make test-e2e ARGS="--project=chromium"` або `make app-build ARGS=--no-cache`.

## Старт

| Ціль           | Що робить                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`        | перший запуск: `doctor`, `install`, `env`, `build-shared`                                                                                                                                                                                 |
| `init`         | старт сесії: `install`, `build-shared`, `check`, `build`. Саме це запускає `./init.sh`                                                                                                                                                    |
| `doctor`       | [`scripts/doctor.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/doctor.sh): Node `^` версії з `.nvmrc` і pnpm `>=9` обов'язкові (інакше код 1); відсутній Docker, `.env` або зайнятий порт — попередження (див. нижче) |
| `install`      | `pnpm install`                                                                                                                                                                                                                            |
| `env`          | копіює `packages/backend/.env.example` у `packages/backend/.env`, тільки якщо `.env` ще немає                                                                                                                                             |
| `build-shared` | `pnpm build:shared`: typecheck і тести backend/frontend імпортують зібраний `shared`                                                                                                                                                      |

Після `make env` відкрийте `packages/backend/.env` і перевірте значення: що потрібно для першого запуску, описано в [Швидкому старті](/guide/getting-started#_2-фаил-env-для-backend).

## Розробка

| Ціль             | pnpm-скрипт       | Що робить                                                                                      |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `dev`            | `dev`             | збирає `shared` і `backend`, запускає dev-сервери backend, frontend і лендінгу                 |
| `dev-backend`    | `dev:backend`     | тільки backend                                                                                 |
| `dev-frontend`   | `dev:frontend`    | тільки frontend                                                                                |
| `dev-landing`    | `dev:landing`     | тільки [лендінг](/landing/) на `http://localhost:5175`                                         |
| `dev-playground` | `dev:manual_test` | backend і API Playground                                                                       |
| `prod-local`     | `prod:local`      | production-подібний запуск: backend віддає зібраний SPA, лендінг — на `vite preview` (`:4174`) |
| `start`          | `start`           | запуск зібраного backend                                                                       |

## Якість

`make check` — те саме, що крок перевірки в job `quality` у [`ci.yml`](https://github.com/Blazheiko/vibe-template/blob/main/.github/workflows/ci.yml): CI після `pnpm install --frozen-lockfile` викликає саме `make check`. Тому зелений `make check` локально означає зелений `quality` у CI (покриття CI рахує окремим кроком).

| Ціль                      | Що робить                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | по черзі `build-shared`, `verify-makefile`, `verify-compose`, `format-check`, `typecheck`, `lint`, `check-bundle-graph`, `test`; зупиняється на першій помилці                                                                                                                                                                                                                                                               |
| `verify-makefile`         | перевіряє сам Makefile (див. вище)                                                                                                                                                                                                                                                                                                                                                                                           |
| `verify-compose`          | [`scripts/verify-compose.mjs`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-compose.mjs): `docker compose config` дає `app` і `migrate` той самий `API_PATH_PREFIX`, що й `docker-build.sh` (shell → `packages/backend/.env` → `api`), а healthcheck питає `/<префікс>/ready`; сервіс `landing` опубліковано на `127.0.0.1:LANDING_PORT` з healthcheck `/healthz`; без `docker compose` пропускається |
| `typecheck`               | `pnpm typecheck`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lint` / `lint-fix`       | `pnpm lint` / `pnpm lint:fix`                                                                                                                                                                                                                                                                                                                                                                                                |
| `check-bundle-graph`      | `pnpm check:bundle-graph`: збирає production-бандл фронтенду й за графом модулів перевіряє, що в ньому немає схем валідації й ArkType ([check-bundle-graph.mjs](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/scripts/check-bundle-graph.mjs), ADR 0005)                                                                                                                                            |
| `format` / `format-check` | `pnpm format` / `pnpm format:check`                                                                                                                                                                                                                                                                                                                                                                                          |

## Тести

| Ціль               | pnpm-скрипт                                  | Примітка                                        |
| ------------------ | -------------------------------------------- | ----------------------------------------------- |
| `test`             | `test` (або `--filter <PKG> test`)           | unit-тести всіх пакетів чи одного               |
| `test-e2e`         | `--filter frontend test:e2e`                 | Playwright                                      |
| `test-e2e-landing` | `build:landing`, `--filter landing test:e2e` | збирає лендінг і запускає його Playwright smoke |
| `test-pg`          | `--filter backend test:pg`                   | потрібен PostgreSQL: `make services-up`         |
| `test-redis`       | `--filter backend test:redis`                | потрібен Redis: `make services-up`              |
| `coverage`         | `test:coverage` у backend і frontend         | як крок Coverage у CI                           |

## Сервіси, база даних і Docker

| Ціль            | pnpm-скрипт           | Що робить                                                                                                          |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services-up`   | `services:up`         | PostgreSQL, Redis, S3 і Mailpit з `docker-compose.yml`, чекає на healthy; `ARGS="redis s3 mailpit"` — лише вказані |
| `services-down` | `services:down`       | зупиняє сервіси й застосунок, дані лишаються у volumes                                                             |
| `db-create`     | `backend db:create`   | створює БД і розширення `vector`                                                                                   |
| `db-migrate`    | `backend db:migrate`  | застосовує міграції Drizzle                                                                                        |
| `db-generate`   | `backend db:generate` | генерує міграцію зі схеми                                                                                          |
| `db-seed`       | `backend db:seed`     | початкові дані; `ARGS=--demo` додає demo-акаунти                                                                   |
| `db-studio`     | `backend db:studio`   | Drizzle Studio                                                                                                     |
| `app-build`     | `app:build`           | збирає образи `vibe-template:local` і `vibe-template-landing:local`                                                |
| `app-up`        | `app:up`              | сервіси, міграції й застосунок у compose                                                                           |
| `app-down`      | `app:down`            | зупиняє й видаляє лише контейнери `app`, `migrate` і `landing`, сервіси працюють далі                              |
| `app-seed`      | `app:seed`            | seed з demo-акаунтами в compose                                                                                    |
| `app-logs`      | `app:logs`            | логи застосунку й лендінгу                                                                                         |

Ланцюжок для чистої машини: `make setup`, правка `.env`, `make services-up db-create db-migrate`, `make dev`. Цілі в одному виклику `make` виконуються по черзі зліва направо. Те саме через pnpm: `pnpm install`, `pnpm build:shared`, `pnpm services:up`, `pnpm --filter backend db:create`, `pnpm --filter backend db:migrate`, `pnpm dev`.

Після перевірки production-образу (`make app-up`) поверніться до розробки так: `make app-down`, потім `make dev`. Контейнер застосунку займає той самий порт 3000, що й `make dev`, а сервіси після `app-down` лишаються запущеними.

### Зайняті порти і свій PostgreSQL

`make doctor` перевіряє (через `lsof`) порти зі `.env`, які потрібні стеку й dev-серверам: `PGSQL_PORT` (5432), `REDIS_PORT` (6379), `S3_HOST_PORT` (8333), `SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025), `PORT` (3000) і 5173. Порт, який тримає Docker, вважається нормою: сервіс, швидше за все, уже запущено. Якщо порт зайняв інший процес, `doctor` попереджає й називає його, наприклад `port 5432 is taken by postgres (PID 1618)`.

Якщо PostgreSQL з pgvector уже встановлено локально (наприклад, через Homebrew), можна працювати з ним і запускати в Docker лише решту:

```bash
make services-up ARGS="redis s3 mailpit"   # pnpm services:up redis s3 mailpit
```

Інші варіанти: зупинити локальний сервер або задати в `.env` інший `PGSQL_PORT` (наприклад, `5433`) — тоді контейнер слухатиме його, а backend підключатиметься до нової порожньої бази (`make db-create db-migrate`).

## Документація і збірка

| Ціль              | pnpm-скрипт       | Що робить                                              |
| ----------------- | ----------------- | ------------------------------------------------------ |
| `docs-dev`        | `docs:dev`        | dev-сервер VitePress                                   |
| `docs-build`      | `docs:build`      | збірка сайту                                           |
| `docs-preview`    | `docs:preview`    | перегляд зібраного сайту                               |
| `docs-verify`     | `docs:verify`     | перевірка збірки: посилання, якорі, ключові сторінки   |
| `build`           | `build`           | збірка всіх пакетів                                    |
| `build-landing`   | `build:landing`   | збірка [лендінгу](/landing/) у `packages/landing/dist` |
| `preview-landing` | `preview:landing` | віддає зібраний лендінг на `http://localhost:4174`     |
| `clean`           | `clean`           | видаляє артефакти збірки й `node_modules`              |

## Windows

Makefile і частина pnpm-скриптів розраховані на Unix-оболонку (`sh`, `awk`, `cp`, `rm -rf`, `VAR=value команда`, запуск `./scripts/*.sh`), тому в cmd і PowerShell вони не працюють.

| Середовище                   | Статус                | Примітка                                                                                                                                              |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WSL2** (наприклад, Ubuntu) | рекомендовано         | працює як Linux; Docker Desktop підключається до WSL2. Тримайте репозиторій у файловій системі WSL (`~/…`), а не в `/mnt/c/…`: так швидше             |
| Git Bash + `make`            | не перевіряється в CI | `sh`, `awk` і `cp` входять у Git for Windows; `make` ставиться окремо (`winget install GnuWin32.Make`, `choco install make` або `scoop install make`) |
| cmd / PowerShell             | не підтримується      | цілі зі shell-синтаксисом (`help`, `doctor`, `env`) і частина pnpm-скриптів (`clean`, `prod:local`, `app:build`) падають                              |

CI запускається тільки на Linux, тому підтримувані середовища — Linux, macOS і WSL2.

## Як додати команду

1. Логіку покладіть у pnpm-скрипт потрібного `package.json` або у файл у `scripts/`.
2. Додайте ціль у відповідну групу Makefile з описом `## …` і впишіть її в `.PHONY`.
3. Запустіть `make verify-makefile` і перевірте, що ціль видно в `make help`.
4. Додайте рядок у таблицю на цій сторінці.
