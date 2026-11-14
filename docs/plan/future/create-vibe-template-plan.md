# План: `npm create vibe-template@latest my-app` (feat-147)

> **Статус:** чернетка, редакція 3 (з урахуванням двох рев'ю), нічого не реалізовано. Запис у `feature_list.json` додається окремим PR у `main` (AGENTS.md, Team Coordination), у цьому плані його ще немає.

## Мета

Одна команда розгортає проєкт із шаблону:

```
npm create vibe-template@latest my-app
pnpm create vibe-template my-app
npx create-vibe-template my-app --yes
```

**Контракт «готовий до роботи»:** після команди та чотирьох кроків (`make services-up`, `make db-create`, `make db-migrate`, `make dev`) застосунок працює: `/api/ready` відповідає, новий користувач реєструється, отримує лист підтвердження в Mailpit (http://localhost:8025) і входить. Завантаження файлів (S3) у контракт **не входить**: це опція з документованим налаштуванням. CLI не запускає сервіси й не створює БД сам, а підсумок явно називає ці кроки.

Шаблон без production і без зворотної сумісності: нова версія пакета видає актуальний шаблон, міграцій старих проєктів немає.

## Поточний стан (перевірено в репозиторії)

- Встановлення зараз: `git clone` + `make setup` (`doctor`, `install`, `env`, `build-shared`). `make env` копіює `.env.example` у `.env`, `APP_KEY` лишається порожнім.
- БД створює окремий крок: `make db-create` (`packages/backend/src/db/create-database.ts`, створює базу й розширення `vector`), далі `make db-migrate`.
- Workspace (`pnpm-workspace.yaml`): `packages/*` і `documentation`. Тому прибрати сайт означає змінити workspace, кореневі скрипти, `Makefile` (розділ `Documentation`), lockfile і `.github/workflows/docs.yml`. `.dockerignore` прямо фіксує: `documentation/` лишається в контексті, бо `--frozen-lockfile` потребує його `package.json`.
- **`docs/` не можна видаляти цілком.** `Dockerfile` копіює `docs/support-knowledge-base`, а `knowledge-base-init-service.ts` читає цю папку (`process.cwd()/docs/support-knowledge-base`). Внутрішні підкаталоги вже перелічені в `.dockerignore` (`docs/adr`, `plan`, `presentations`, `reference`, `requirements`, `screenshots`, `security`): цей список беремо за основу manifest.
- **`LICENSE` лишається.** Його текст вимагає зберігати повідомлення про авторські права у всіх копіях. Це єдине дозволене входження `vibe-template`/автора, яке перевірка залишків має пропускати.
- Інше, що належить авторам шаблону: `feature_list.json`, `.omx/`, `.claude/`, `AGENTS.md` (workflow агентів), `corsS3.xml`, `corsS3.prod.example.xml`, `.git-blame-ignore-revs`, `.idea/`.
- Імена `vibe-template` і `Blazheiko/vibe-template` зустрічаються в `package.json`, `README`, `docker-compose.yml`, документації й конфігах. Повний перелік складає завдання 1.
- У `.env.example` `AUTH_STRICT_REGISTRATION=true`, а `SMTP_ENABLED=false`. `auth-service` не пускає користувача з непідтвердженим email, тож із вимкненим SMTP новий користувач не зможе увійти. Mailpit у `docker-compose.yml` є, а готовий набір змінних для нього вже лежить закоментованим у `.env.example` (`SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_REQUIRE_TLS=false SMTP_IGNORE_TLS=true`). S3-параметри порожні (рішення D6).
- `documentation/scripts/verify-dist.mjs` має зашитий `BASE = '/vibe-template/'`, а `.vitepress/config.ts` формує `editLink` і футер із `repoUrl`, автора та email. Після перейменування сайт без змін цих місць збереться, але `docs:verify` і посилання вестимуть у репозиторій шаблону.
- `uWebSockets.js` ставиться з GitHub (`github:...#v20.71.0`) з патчем у `patches/`, тож `pnpm install` потребує `git` і мережі.
- Вимоги: Node `^24.22.2` (`.nvmrc`), pnpm `>=9`; `scripts/doctor.sh` вже перевіряє їх.

## Рішення, які треба прийняти до старту

| # | Питання | Рекомендація | Чому |
|---|---|---|---|
| D1 | Доставка шаблону | **Вбудувати** в npm-пакет (збирається в `prepack`) | Працює офлайн, версія шаблону = версія CLI. Мінус: реліз на кожну зміну, його автоматизує CI |
| D2 | Ім'я пакета | Перевірити зайнятість `create-vibe-template`; запасний `@blazheiko/create-vibe` | `npm create foo` резолвиться в `create-foo` |
| D3 | Agent-harness у проєкті | **Опція**, за замовчуванням «ні». Якщо «так»: порожні шаблонні `AGENTS.md` і `feature_list.json`, не файли з історією шаблону | Це процес авторів шаблону |
| D4 | Сайт `documentation/` | **Опція**, за замовчуванням «ні». Вимкнення = **трансформація конфігурації**, не лише видалення файлів (див. «Manifest») | Сайт описує шаблон, а не проєкт користувача |
| D5 | Де живе пакет | `packages/create-vibe-template` | Спільний CI. Сам пакет **виключається** з копії, інакше генератор копіював би себе |
| D6 | Узгодження `packages/backend/.env` із сервісами Compose | Генерувати `APP_KEY` **і вмикати SMTP на Mailpit** (`SMTP_ENABLED=true`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_REQUIRE_TLS=false`, `SMTP_IGNORE_TLS=true`, `SMTP_FROM_EMAIL=noreply@example.com`), `AUTH_STRICT_REGISTRATION=true` не чіпати. S3 лишається вимкненим; підсумок вказує на закоментований блок у `.env.example` | Інакше обіцяний вхід не працює через strict registration. Одного попередження в підсумку недостатньо. Mailpit піднімає той самий `make services-up`. Якщо користувач запустить підмножину сервісів без Mailpit, це його свідомий вибір, документація про це попереджає |
| D7 | Вибір сервісів у діалозі | **Прибрати з MVP.** Лишається повний Compose; запуск підмножини документується (`make services-up ARGS="redis s3 mailpit"`) | Інакше незрозуміло, що саме опція змінює: Compose, `.env` чи лише команду |
| D8 | Прапорець `--template-version` | **Прибрати.** Старий шаблон = стара версія npm-пакета (`@x.y.z`) | Суперечить «версія шаблону = версія CLI» |
| D9 | Публікація | **npm Trusted Publishing (OIDC)** з GitHub Actions, без довгоживучого токена | Прибирає секрет у репозиторії, provenance автоматично |

## Структура пакета

```
packages/create-vibe-template/
  package.json            # bin, files: [dist, template], publishConfig
  src/
    cli.ts                # аргументи, запуск кроків, обробка Ctrl+C
    prompts.ts            # діалог (clack) + --yes
    steps/
      checks.ts           # Node, pnpm, git (залежно від вибраних дій), цільова директорія
      copy.ts             # копіювання template/ за manifest
      transform.ts        # перейменування й зміни конфігурації (docs/harness)
      env.ts              # .env з APP_KEY
      install.ts          # pnpm install + build shared
      git.ts              # git init + перший коміт після install
    manifest.ts           # файли + трансформації для кожної опції
  scripts/
    build-template.mjs    # prepack: збирає template/ з кореня за manifest
  test/
```

`template/` не зберігається в git: його збирає `prepack` з поточного дерева за manifest. Шаблон не існує у двох копіях.

### Особливості пакування npm

- npm **не включає `pnpm-lock.yaml`** у пакет. **Рішення зафіксовано:** lockfile готуються **під час пакування** для кожного складу workspace і лежать у `template/` як `.tpl`: `pnpm-lock.with-docs.yaml.tpl` та `pnpm-lock.no-docs.yaml.tpl`. Склад workspace визначає лише `--with-docs` (harness його не змінює); `packages/create-vibe-template` виключено з обох. CLI під час генерації відновлює потрібний файл як `pnpm-lock.yaml`. `pnpm install --lockfile-only` у runtime **не викликається**: `--no-install --no-git` не вимагає `pnpm`.
- Імена workspace-пакетів (`frontend`, `backend`, `shared`) CLI **не перейменовує**, міняється лише `name` кореневого `package.json` та згадки в текстах. Тоді підготовлені lockfile лишаються чинними. (Перевірити в завданні 1, що кореневе ім'я не потрапляє в lockfile.)
- **Критерій:** після генерації будь-якої комбінації, зокрема з `--no-install`, звичайний `pnpm install --frozen-lockfile` успішний.
- `.gitignore` теж не потрапляє в архів як є (npm перейменовує/ігнорує); зберігаємо як `gitignore.tpl` і відновлюємо.
- Вкладені ignore-файли впливають на вміст архіву, тому склад пакета перевіряється на справжньому `.tgz`, а не за конфігом.
- Окремо перевіряємо наявність у `template/`: `.gitignore`, `.env.example`, lockfile, `patches/`, права виконання скриптів (`init.sh`, `scripts/*.sh`), і відсутність секретів (`.env*` крім `.env.example`). `files: [dist, template]` сам по собі не захищає від секрету всередині `template/`.

### Manifest

Для кожної опції описує **і файли, і зміни конфігурації**:

| Опція | Файли | Зміни конфігурації |
|---|---|---|
| завжди видалити | `feature_list.json`, `.omx/`, `.claude/`, `.idea/`, `corsS3*.xml`, `.git-blame-ignore-revs`, `docs/` крім `docs/support-knowledge-base/`, `packages/create-vibe-template/` | |
| завжди залишити | `LICENSE`, `docs/support-knowledge-base/` | |
| без `--with-docs` | `documentation/`, `.github/workflows/docs.yml` | `pnpm-workspace.yaml` (прибрати `documentation`), кореневі скрипти `docs:*`, розділ `Documentation` у `Makefile` і `.PHONY`, `scripts/verify-makefile.mjs`-узгодженість, lockfile `no-docs`, `.dockerignore`/`Dockerfile`, якщо згадують `documentation` |
| `--with-docs` | `documentation/`, `.github/workflows/docs.yml` | lockfile `with-docs`; `BASE` у `verify-dist.mjs`, `repoUrl`, автор і email у `.vitepress/config.ts`, `paths` у `docs.yml`. **Джерело metadata:** діалог їх не запитує. Нейтральні defaults для згенерованого сайту: `editLink` приховується, якщо URL репозиторію не заданий; поля автора й email у футері порожні й не рендеряться; налаштування документується на сторінці «Швидкий старт» (де задати `repoUrl`, автора, `BASE`). Рекомендація: **спершу в самому репозиторії** винести ці значення в конфіг (одне джерело), а CLI підставляє їх, а не правки `sed` по тексту (завдання 1) |
| без `--with-harness` | `AGENTS.md`, `init.sh` (або залишити як обгортку над `make init`: рішення в завданні 1) | згадки harness у `README` |
| `--with-harness` | порожні `AGENTS.md`, `feature_list.json` | |
| завжди | | імена пакетів, `docker-compose.yml`, `README`, посилання на репозиторій |

Перевірка цілісності: `make verify-makefile` має проходити у всіх комбінаціях.

## Кроки CLI

1. **Базові перевірки:** Node у діапазоні `engines`; цільова директорія порожня або не існує.
2. **Діалог й розв'язання опцій.** Пріоритет: **явні прапорці > `--yes` > відповіді діалогу**; `--no-install`/`--no-git` завжди переважають `--yes`. Значення `--yes`: назва з аргументу, без docs, без harness, `git init` так, `pnpm install` так. Без `--yes` у неінтерактивному терміналі CLI завершується з підказкою передати `--yes` або прапорці.
3. **Залежні перевірки** (вже після розв'язання опцій): `pnpm` лише якщо буде install; `git` лише якщо буде `git init` або install (`uWebSockets.js` ставиться з GitHub). `--no-install --no-git` не вимагає ні `pnpm`, ні `git`.
4. **Копіювання** `template/` за manifest, відновлення `.tpl`-файлів (lockfile, `.gitignore`).
5. **Трансформації:** перейменування й зміни конфігурації за manifest (не `sed` навмання).
6. **`packages/backend/.env`:** копія `packages/backend/.env.example` з випадковим `APP_KEY` (`crypto.randomBytes`) і блоком SMTP на Mailpit (D6). Існуючий `.env` не перезаписується.
7. **`pnpm install --frozen-lockfile`** і `pnpm build:shared`.
8. **`git init`** і перший коміт **після install**, щоб до нього потрапив актуальний lockfile. Якщо не налаштовані `user.name`/`user.email`, коміт пропускається з поясненням, а проєкт лишається робочим.
9. **Підсумок:**
   ```
   cd my-app
   pnpm install --frozen-lockfile && pnpm build:shared   # лише якщо install пропущено (--no-install) або не вдався
   make services-up
   make db-create
   make db-migrate
   make dev
   ```
   Перший рядок друкується тільки після `--no-install` (або збою install); ця сама команда використовується для повтору після помилки. Далі: листи підтвердження приходять у Mailpit (http://localhost:8025); S3 не налаштовано, див. блок у `.env.example`.

Прапорці першого релізу: `--yes`, `--no-install`, `--no-git`, `--with-docs`, `--with-harness`, `--dry-run`.

## Поведінка при помилках

- **Помилка install:** проєкт лишається на місці, підсумок друкує команду для повтору (`cd my-app && pnpm install --frozen-lockfile && pnpm build:shared`, та сама, що в підсумку для `--no-install`), код виходу ненульовий.
- **Ctrl+C:** CLI видаляє лише те, що створив сам у цій спробі, і лише якщо директорію створено ним; директорію, яка існувала й була порожньою, не видаляє. Файли користувача не чіпає ніколи.
- **`--dry-run`:** друкує план (які файли, які трансформації), нічого не пише на диск, не запускає install і git.
- **Немає Git identity:** див. крок 8.
- **Зовнішні інструменти** перевіряються відповідно до вибраних дій: `--no-install --no-git` не вимагає ні `pnpm`, ні `git`.

## Завдання

Кожне завдання — окремий невеликий PR у гілку `feat/create-vibe-template`, ≤1 дня.

1. **Інвентаризація.** Повний перелік файлів, які вирізати, і всіх місць із `vibe-template`; manifest із файлами й трансформаціями (таблиця вище); рішення щодо `init.sh` і lockfile для варіантів без docs.
2. **Каркас пакета.** `packages/create-vibe-template`, `bin`, збірка, `--help`, `--version`.
3. **Збірка шаблону й пакування.** `build-template.mjs`, `.tpl`-файли (**два lockfile**: `with-docs` і `no-docs`, gitignore), перевірки складу `template/` (немає секретів, є `patches/`, права виконання). Тест: для обох складів `pnpm install --frozen-lockfile` проходить.
4. **Кроки 1–5:** перевірки, діалог і пріоритет прапорців, копіювання, трансформації. Тести на всіх комбінаціях опцій docs × harness (структурні перевірки для кожної: `make verify-makefile`, відсутність висячих посилань).
5. **`.env`, install, git, підсумок** (кроки 6–9), поведінка при помилках і `--dry-run`.
6. **CI на справжньому архіві (до релізу).** Сценарій: `build → npm pack → запуск CLI з локального .tgz → scaffold → install → make check`. Дефолтна комбінація: повний прогін. Варіант з `--with-docs`: додатково `pnpm docs:build && pnpm docs:verify` у згенерованому проєкті (доводить, що `BASE`, `repoUrl` і перевірка посилань відповідають новому проєкту). Решта комбінацій: структурні перевірки і `pnpm install --frozen-lockfile`, зокрема після `--no-install`.
7. **CI: працюючий застосунок.** Згенерований проєкт: PostgreSQL, Redis і **Mailpit** через Compose (Mailpit обов'язковий: сценарій читає лист через його API), `make db-create`, `make db-migrate`, запуск, перевірка `/api/ready`; реєстрація тестового користувача через API, лист у Mailpit (API Mailpit), підтвердження email і вхід; окремо `docker build` згенерованого проєкту (виявляє помилки на кшталт видаленої бази знань).
8. **Публікація через Trusted Publishing (OIDC) і перевірка опублікованої команди.** Налаштувати trusted publisher для пакета на npmjs.com, workflow з `id-token: write`, вимоги до версій npm/runner за документацією npm; перший реліз з `--dry-run`; без довгоживучого токена. Після публікації окремий job/ручний чек запускає `npm create vibe-template@latest` у чистому середовищі й повторює smoke з завдання 7.
9. **Документація** (одним PR, обидві локалі): сторінка «Швидкий старт» (UK і `en/`), сайдбар у `config.ts`, `KEY_PAGES`/`EN_KEY_PAGES` у `scripts/verify-dist.mjs`, `README`. Перед злиттям: `pnpm docs:build && pnpm docs:verify`.

## Ризики

| Ризик | Захист |
|---|---|
| Manifest розходиться з репозиторієм | Завдання 6 і 7 на кожному PR; `make verify-makefile` у згенерованому проєкті |
| CLI створює проєкт, що проходить `make check`, але не стартує | Завдання 7: `/api/ready`, міграції, `docker build` |
| У пакеті бракує файлів, які npm виключає (lockfile, `.gitignore`) | `.tpl`-перейменування і тест на `.tgz` (завдання 3, 6) |
| Секрет потрапляє в пакет | Перевірка складу `template/` і самого `.tgz` у CI |
| `uWebSockets.js` з GitHub не ставиться без `git`/мережі | Перевірка в кроці 1 і зрозуміле повідомлення |
| Ім'я пакета зайняте | D2: перевірити до завдання 2 |
| `npx` кешує стару версію | У документації `@latest`; CLI друкує свою версію |
| Згенерований проєкт містить сайт/workflow шаблону або саме CLI | Manifest: завдання 1, 4; перевірка залишків із allowlist для `LICENSE` |

## Критерії готовності (Definition of Done)

**До релізу, у цьому репозиторії (CLI зі справжнього локального `.tgz`):**

- scaffold дефолтної конфігурації дає проєкт, де `pnpm install --frozen-lockfile` і `make check` проходять; для всіх чотирьох комбінацій docs × harness (зокрема після `--no-install`) `pnpm install --frozen-lockfile` успішний;
- у варіанті `--with-docs` проходить `pnpm docs:build && pnpm docs:verify` у згенерованому проєкті;
- у згенерованому проєкті після `make services-up && make db-create && make db-migrate` застосунок стартує, `/api/ready` успішний, тестовий користувач реєструється, підтверджує email через лист у Mailpit і входить; `docker build` проходить;
- немає файлів зі списку вирізання, `docs/support-knowledge-base/` і `LICENSE` на місці, `grep -r vibe-template` не знаходить залишків поза allowlist;
- в основному репозиторії `pnpm typecheck`, `pnpm lint`, `pnpm test` та `pnpm docs:build && pnpm docs:verify` чисті.

**Після публікації (окремо):**

- `npm create vibe-template@latest my-app --yes` у чистому середовищі проходить той самий smoke, що й завдання 7;
- ручний golden path на macOS і Linux; Windows поза межами, це позначено в документації; завантаження аватара перевіряється після налаштування S3 за інструкцією;
- запис feat-147 у `feature_list.json` переведено в `done` з evidence обох етапів.

## Поза межами

- Генератори `make:*` (route, controller, service): окрема фіча.
- Оновлення вже створених проєктів до нової версії шаблону.
- Вибір підмножини сервісів у діалозі (D7) і `--template-version` (D8).
- npm/yarn як менеджер проєкту (шаблон прив'язаний до pnpm workspace).
