# Frontend: бандл, оновлення, a11y, діалоги — покроковий task list

Джерело: [`frontend-technical-analysis-2026-11-28.md`](../frontend-technical-analysis-2026-11-28.md), розділ 4 (пункти 1–10). Базовий шлях: `packages/frontend/`, якщо не вказано інше. Коміт для посилань на рядки: `5aa41461`.

Кожна фіча — окремий рядок у `feature_list.json`, гілка і PR (правила `AGENTS.md`). Задача T* — один коміт або кілька дрібних; вона закінчується зеленим вузьким тестом свого рівня. Позначення тестів: `*.spec.ts` у `src/**/__tests__` — `pnpm --filter frontend test`; `e2e/**` — `pnpm --filter frontend test:e2e`; `e2e-security/**` — `pnpm --filter frontend test:e2e:security`; `e2e-live/**` — `pnpm --filter frontend test:e2e:live`.

**Definition of Done для кожної фічі:** `make check`; `pnpm --filter frontend test:e2e` (зміни UI); `test:e2e:security`, якщо зачеплено SW, CSRF чи завантаження чанків; `pnpm docs:build && pnpm docs:verify`, якщо змінено `documentation/`; ручна перевірка golden path; для фіч із бюджетом — замір до і після. Усе це в `feature-state/<feat-id>/progress.md` → Evidence of Completion.

**Переклади:** локалі `src/locales/en.ts`, `uk.ts`, `pl.ts`. `uk.ts` і `pl.ts` типізовані як `typeof en`, тож пропущений ключ ловить `pnpm typecheck`; кожен новий ключ — у всіх трьох одночасно.

**v2 — після рев'ю task list:** перехід A → B зі справжніми збірками й перезапуском сервера, відновлення на цільовий маршрут, без автоматичного reload без `sessionStorage` (T5–T6); бюджет `/login` — максимум для `en`/`uk`/`pl` зі свіжої збірки, базовий замір тим самим скриптом (T2); бюджет і Sentry, тести ранніх помилок і першої навігації (T14, T16); точна умова PWA-fallback і підписки за ref (T19–T20); конкретний сценарій `logout_retry` (T30); нові спеки підтримки й бази знань (T28, T52).

**v3:**

- Відновлення чанків без гонки між `vite:preloadError` і `router.onError` (активна навігація відстежується), ключ від `to.path` без query, очікуваний перший reload не йде в Sentry (T5).
- Sentry: за ввімкненого SDK — `await sentry.init()` до `app.mount` (T14).
- PWA: попереднє завантаження на `pointerenter`/`focus`, регресійна перевірка `BeforeInstallPromptEvent` у Chromium (T19–T20).
- Скриншоти — окремий локальний конфіг поза CI, із заблокованими зовнішніми шрифтами (T22, T47).
- e2e модалок на `getByRole('dialog')` до появи `UiModal` (T40); `busy`/`variant` у `ConfirmDialog` (T28).
- `RouteMeta` в `env.d.ts`, `LocationQueryRaw` замість `as never` (T33, T36); прибрано коментар-заглушку toast (T30).
- i18n хедера, меню й `PwaInstallButton` перенесено у `feat-279`; решту колишньої `feat-285` злито з `feat-284`. Фіч тепер 10 (`feat-278`…`feat-287`); нумерація пунктів у таблиці збігається з розділом 4 аналізу.
- Явний розділ «Поза scope» з рішеннями щодо `manualChunks`, `skipWaiting()` і listener-ів.

## Відповідність і порядок

| Фіча       | Пункт §4 аналізу | Гілка                         | Задачі  | Залежить від           |
| ---------- | ---------------- | ----------------------------- | ------- | ---------------------- |
| `feat-278` | 1                | `feat/fe-lazy-routes`         | T1–T7   | —                      |
| `feat-279` | 2                | `feat/fe-header-keyboard`     | T8–T12  | —                      |
| `feat-280` | 3                | `feat/fe-sentry-lazy`         | T13–T17 | `feat-278`             |
| `feat-281` | 4                | `feat/fe-pwa-install-lazy`    | T18–T21 | `feat-278`, `feat-279` |
| `feat-282` | 5                | `feat/fe-css-cleanup`         | T22–T26 | `feat-278`             |
| `feat-283` | 6                | `feat/fe-native-dialogs`      | T27–T31 | `feat-279`             |
| `feat-284` | 7                | `feat/fe-router-meta-404`     | T32–T38 | `feat-278`, `feat-279` |
| `feat-285` | 8                | `feat/fe-ui-modal`            | T39–T44 | `feat-283`             |
| `feat-286` | 9                | `feat/fe-account-decompose`   | T45–T49 | `feat-282`, `feat-285` |
| `feat-287` | 10               | `feat/fe-support-admin-split` | T50–T53 | `feat-285`             |

Частина залежностей — не логічна, а через спільні файли: `feat-281`, `feat-283` і `feat-284` залежать від `feat-279` (`MenuButton.vue`, `AppHeader.vue`), щоб не було конфліктів. `feat-280`, `feat-281` і `feat-282` залежать від `feat-278`, бо міряють його скриптом бюджету (T17, T21, T26). `feat-286` залежить від `feat-282`, бо використовує його візуальну перевірку (T47).

`AGENTS.md` дозволяє **одну активну фічу на власника**. Рекомендований порядок для одного власника: `feat-278` → `feat-279` → `feat-280` → `feat-281` → `feat-284` → `feat-283` → `feat-282` → `feat-285` → `feat-286` → `feat-287`. Паралельно (`feat-278` ‖ `feat-279`, як радить аналіз) — лише з різними власниками.

Кожна фіча стартує однаково (у задачах нижче скорочено до «Старт фічі»):

- PR до `main` з короткої гілки `chore/feat-XXX-start`: `feat-XXX` → `in_progress`.
- Гілка фічі від `main`, `feature-state/feat-XXX/progress.md` і `session-handoff.md`.
- `./init.sh` зелений; результат у `progress.md`.

І закінчується однаково: Evidence of Completion → PR `review` → рев'ю → злиття → PR «Mark feat-XXX done».

### T0 · Реєстрація фіч

- [ ] PR до `main` з гілки `chore/frontend-plan`: аналіз, цей task list і рядки `feat-278`…`feat-287` у `feature_list.json` (`status: not-started`, `owner`, `branch`, `dependencies` з таблиці вище; `description` — короткий зміст розділу фічі з посиланням на цей файл).

---

## feat-278 · Lazy-loading маршрутів, перехід між збірками, бюджет холодного старту

### T1 · Старт фічі

- [ ] Старт фічі.

### T2 · Скрипт бюджету холодного старту; базовий замір

**Що міряємо.** Сума gzip JS і CSS, яку браузер завантажує до першого рендеру `/login`: entry з усіма статичними `imports` і `css`, плюс чанк інтерфейсної локалі. `en` уже в статичному графі ([`plugins/i18n.ts`](../../packages/frontend/src/plugins/i18n.ts) імпортує її напряму), а `uk`/`pl` `useLocale` довантажує до монтування залежно від мови браузера (`loadLocale(browserLocale())`). Тому рахується окремо для `en`, `uk`, `pl`, а з лімітом порівнюється **максимум із трьох**.

**Звідки дані.** `check-bundle-graph` запускає Vite з `build: { write: false }` і нічого не пише на диск, а `dist/` може бути застарілим. Тому скрипт сам запускає `vite build` (`build.manifest: true`, `outDir` — тимчасова тека, яку він видаляє після себе) і читає `.vite/manifest.json` саме цієї збірки. Залежності від наявного `dist/` немає.

**Зміни**

- [ ] `scripts/check-cold-start-budget.mjs`: свіжа збірка в тимчасову теку → маніфест → обхід статичного графа entry `index.html` (без `dynamicImports`) → додавання чанка локалі для `en`/`uk`/`pl` → таблиця трьох сум (gzip) і максимум.
- [ ] Перелік пакетів, заборонених у холодному старті (порожній на цьому кроці; поповнюється в T15 і T21).
- [ ] Ліміт — константа у скрипті з коментарем «звідки число»; перевищення → ненульовий код виходу з переліком файлів і розмірів.
- [ ] pnpm-скрипт `check:cold-start` у `packages/frontend/package.json`; підключити в `make check` після `check-bundle-graph`, ціль Makefile з `## description`.

**Базовий замір**

- [ ] До будь-яких змін маршрутів запустити **цей самий скрипт** і записати в `progress.md` три суми й максимум — точка відліку. Усі наступні заміри (T7, T17, T21, T26) — тим самим скриптом, щоб до і після рахувалися однаково.

**Тести**

- [ ] Unit на чисті функції (фікстура маніфесту: entry + статичний імпорт + динамічний імпорт + CSS + три локалі): динамічний імпорт не враховується, статичний CSS враховується, `en` не рахується двічі, з лімітом порівнюється максимум.
- [ ] На цьому кроці ліміт = базовий максимум + невеликий запас, щоб `make check` лишався зеленим.

### T3 · Lazy-loading маршрутів

**Зміни** (`src/router/index.ts`)

- [ ] Замінити статичні імпорти рядків 6–17 на `component: () => import(...)`: `UserAccount`, `ManifestoSocial`, `SupportView`, `AdminLayout` і всі admin-сторінки, `VerifyEmailView`, `ResetPasswordView`, `OAuthLinkConfirmView`. `Login` лишається статичним.
- [ ] `adminRedirect` з `admin-pages.ts` лишається статичним (потрібен у guard) — перевірити, що цей модуль не тягне за собою view-компоненти.

**Тести**

- [ ] Наявні e2e (`e2e/mock/**`) зелені без змін: навігація в акаунт, адмінку, verify/reset/OAuth.

### T4 · `AvatarEditorModal` при відкритті

- [ ] `src/views/UserAccount.vue`: `AvatarEditorModal` через `defineAsyncComponent(() => import(...))`, рендер лише за `v-if` відкритого стану, щоб `vue-advanced-cropper` вантажився при першому відкритті.
- [ ] Перевірити: `e2e/mock/account-profile.spec.ts` (аватар) зелений; у збірці `vue-advanced-cropper` в окремому чанку.

### T5 · Відновлення після помилки завантаження чанка

**Порядок подій.** Помилка імпорту відкладеного маршруту стається до того, як адреса в рядку змінилася. `vite:preloadError` спрацьовує синхронно **раніше**, ніж rejection дійде до `router.onError`. Якщо обробник на `window` перезавантажить сторінку сам, він зробить це на старий `location.href` і випередить `router.onError`, який знає цільовий `to`.

**Зміни** — `src/utils/preload-recovery.ts` (чиста логіка + тонка обв'язка в `main.ts` до монтування):

- [ ] **Активна навігація.** `router.beforeEach` запам'ятовує `pendingNavigation = to`, а `router.afterEach` і `router.onError` її скидають.
- [ ] **`vite:preloadError` на `window`.** Завжди робить `event.preventDefault()`.
    - Є `pendingNavigation`: нічого більше не робить, відновленням займається `router.onError`.
    - Немає (імпорт поза навігацією, наприклад `AvatarEditorModal`): відновлення на `location.href`.
- [ ] **`router.onError(error, to)`** для помилки завантаження чанка: відновлення на `to.fullPath` через `location.assign`.
- [ ] **Правила відновлення** (однакові для обох шляхів):
    - `navigator.onLine === false` — без reload: повідомлення «немає мережі», повтор на цільову адресу після події `online`.
    - Інакше — одноразовий reload. Позначка спроби в `sessionStorage` у `try/catch`; ключ: `to.path` (**без query**, щоб туди не потрапляли `?token=`) + build timestamp поточної збірки.
    - Позначка вже є (reload не допоміг) — без reload: видиме повідомлення з кнопкою «Оновити сторінку». Позначку скинути після успішної навігації.
    - `sessionStorage` недоступний (захисту від циклу немає) — **без автоматичного reload**: одразу повідомлення з ручною дією.
- [ ] **Sentry.** Наявний `router.onError` у [`main.ts`](../../packages/frontend/src/main.ts) (рядки 33–45) не відправляє в Sentry помилку чанка, для якої відновлення запускає перший очікуваний reload або чекає `online`. Відправляє лише тоді, коли відновлення здалося (повторна помилка після reload).
- [ ] Тексти — ключі i18n у трьох локалях.

**Тести** (`src/utils/__tests__/preload-recovery.spec.ts`)

- [ ] `vite:preloadError` під час активної навігації не перезавантажує сторінку; `router.onError` після нього — один reload на `to.fullPath`, а не на поточну адресу.
- [ ] Помилка поза навігацією → reload на `location.href`.
- [ ] Друга помилка поспіль → без reload, повідомлення, подія в Sentry; перша — без події в Sentry.
- [ ] Офлайн → без reload, повтор після `online`.
- [ ] Недоступний `sessionStorage` → не падає, reload не викликається, повідомлення з ручною дією.
- [ ] Ключ позначки не містить query (`?token=…`).

### T6 · Сценарій «збірка A → деплой B»

Два рівні перевірки: підміна відповіді перевіряє лише реакцію на помилку імпорту, а справжній перехід між збірками — окремий прогін. Бекенд індексує статику один раз під час старту ([`static-server.ts`](../../packages/backend/src/vendor/start/static-server.ts)), тому копіювання нового `dist` під запущеним процесом не відтворює деплой — сервер треба перезапускати.

- [ ] **Реакція на помилку імпорту** (`e2e-security/stale-chunk.spec.ts`, security-конфіг збирає прод через `prod-local.sh`): `page.route` повертає 404 для чанка відкладеного маршруту → один reload, і відкривається **саме цільовий маршрут**, хоча до reload його не було в адресному рядку.
- [ ] **Тимчасовий збій при `navigator.onLine === true`**: перший запит чанка обривається (`route.abort()`), наступні проходять → після одного reload відкривається цільовий маршрут, циклу немає.
- [ ] **Офлайн**: `context.setOffline(true)` → повідомлення без reload; `setOffline(false)` → маршрут відкривається.
- [ ] **Справжні A і B з активним SW** (скрипт `scripts/stale-build-check.sh` або окремий Playwright-конфіг): зібрати A, запустити сервер, відкрити `/login`, дочекатися активного SW; зібрати B (інший build timestamp), **перезапустити сервер** на `dist` B; у тій самій вкладці перейти у відкладений маршрут → один reload, сторінка й SW збірки B, циклу немає. Якщо в CI це занадто повільно — запуск вручну, вивід у Evidence of Completion.
- [ ] **Рішення щодо SW** записати в `progress.md` і документацію: `self.skipWaiting()` в `install` ([`service-worker.ts:214`](../../packages/frontend/src/service-worker.ts)) свідомо лишається. Старі чанки після деплою зникають і на сервері (образ містить `dist` лише однієї збірки), тож відкладене оновлення SW за кліком в `UpdateNotification` проблему не прибрало б. Відновлення забезпечує T5, а сценарій A → B з активним SW це підтверджує.

### T7 · Підсумковий бюджет і документація

- [ ] Новий замір; знизити ліміт у `check-cold-start-budget.mjs` до нового розміру + запас; записати до/після в `progress.md`.
- [ ] `documentation/frontend/` (обидві локалі): короткий розділ про lazy-маршрути, відновлення після помилки завантаження чанка, рішення щодо `skipWaiting()` і бюджет холодного старту; `pnpm docs:build && pnpm docs:verify`.

---

## feat-279 · Клавіатурна навігація та переклади в хедері

Усі тексти `AppHeader.vue`, `MenuButton.vue` і `PwaInstallButton.vue` переходять в i18n тут, а не в окремій фічі: так ці файли й селектори `getByRole('button', { name })` у новому e2e змінюються один раз.

### T8 · Старт фічі

- [ ] Старт фічі.

### T9 · Переклади й доступні назви

- [ ] `src/components/MenuButton.vue`:
    - гамбургер — `aria-label` з i18n (`menu.open`/`menu.close` залежно від стану), `aria-expanded`, `aria-controls` на id панелі (`useId()`), `aria-haspopup="true"`;
    - `Navigation`, `Logging out...` та інші англійські пункти → i18n.
- [ ] `src/components/AppHeader.vue`:
    - кнопка Back — `aria-label` з i18n, видимий `<span>` для десктопу — той самий ключ;
    - статуси WebSocket (`Connected`, `Connecting...`, `Disconnected`, `Unknown`), `Support`, `WebSocket Status: …` → i18n.
- [ ] `src/components/PwaInstallButton.vue`: `Install App` → i18n.
- [ ] Ключі в `en.ts`, `uk.ts`, `pl.ts`; `pnpm typecheck` зелений; `e2e/mock/locale.spec.ts` зелений. Англійські тексти в `en.ts` лишаються такими самими, як зараз у коді, тож наявні селектори e2e (`getByRole('button', { name: 'Sign In' })` тощо) не змінюються.

### T10 · `Escape` і повернення фокуса

- [ ] `MenuButton.vue`: `Escape` при відкритому меню закриває його й повертає фокус на гамбургер; закриття кліком поза меню фокус не краде.
- [ ] Відкриття меню переносить фокус на перший пункт.

### T11 · Згорнуті секції поза порядком табуляції

- [ ] `.group-items` без `.expanded` — атрибут `inert` (`:inert="openGroup !== '…'"`); анімація висоти лишається. Кнопка-заголовок секції — `aria-expanded` і `aria-controls`.

### T12 · Тести

- [ ] `e2e/mock/header-keyboard.spec.ts`:
    - доступні назви через `getByRole('button', { name })` на мобільному viewport;
    - `Tab` з відкритого меню не потрапляє в згорнуту секцію; розгортання секції робить її кнопки досяжними;
    - `Escape` закриває меню, фокус на гамбургері;
    - з мовою `uk` назви кнопок і статус WebSocket — українською.
- [ ] Unit (якщо логіка винесена в composable) на перемикання `openGroup`.

---

## feat-280 · Sentry: lazy-loading SDK

### T13 · Старт фічі; фіксація поточної поведінки

- [ ] Старт фічі.
- [ ] Перелік поточних гарантій для регресії: `e2e/sentry/**` (Replay-маскування, `replay-url-token.spec.ts`), санітизація в `beforeSend`/`beforeBreadcrumb`/`beforeSendSpan`. Записати в `progress.md`.

### T14 · Фасад і момент ініціалізації

**Рішення про момент запуску.** Vue перехоплює помилки в `setup()`/render через `app.config.errorHandler`, і до `window.error` вони не завжди доходять. `browserTracingIntegration({ router })` може не прив'язати `pageload`-транзакцію до першого маршруту, якщо `Sentry.init` виконається після першої навігації. Тому:

- `VITE_SENTRY_ENABLED=true` — `await sentry.init(app, router)` **до** `app.mount`. SDK вантажиться динамічно, але монтування чекає на нього, тож помилки першого монтування, `pageload` і Replay працюють як зараз. Ціна — затримка першого рендеру на завантаження SDK; її виміряти й записати (T16).
- `VITE_SENTRY_ENABLED=false` — `init` синхронно повертає керування, імпорту й мережевих запитів немає.
- Помилка завантаження SDK не блокує застосунок: `init` ловить її, вимикає Sentry і повертає керування, після чого виконується `app.mount`.
- Тимчасовий `app.config.errorHandler` у фасаді не потрібен, поки `init` чекає до монтування. Якщо від `await` колись відмовляться — він обов'язковий: буферизує Vue-помилки до `Sentry.init`, а потім передає керування SDK.

**Зміни** (`src/utils/sentry-service.ts`, `src/main.ts`)

- [ ] Прибрати статичний `import * as Sentry from '@sentry/vue'`; `init(app, router): Promise<void>` за `sentryConfig.enabled` робить `await import('@sentry/vue')`, далі той самий `Sentry.init` з тією ж санітизацією.
- [ ] Публічний API (`captureException`, `setUser`, …) не змінюється. Виклики до завантаження SDK потрапляють в обмежений буфер (наприклад, 50 подій) і після `Sentry.init` відтворюються в порядку надходження. За вимкненого Sentry буфера немає, виклики — no-op.
- [ ] `window` `error`/`unhandledrejection` до завантаження SDK — у той самий буфер.
- [ ] `replayIntegration` — окремий динамічний `import()` після `Sentry.init` (`Sentry.addIntegration`), лише якщо Replay увімкнено.
- [ ] `main.ts`: `await sentry.init(app, router)` перед `app.mount('#app')` (bootstrap стає `async`).

**Бюджет при ввімкненому Sentry.** За ввімкненого Sentry SDK зникає зі статичного графа, але все одно завантажується на `/login`. Бюджет холодного старту (T2) діє для конфігурації за замовчуванням, без Sentry, і гарантує, що SDK не потрапляє в статичний граф. Мережевий розмір `/login` з увімкненим Sentry вимірюється окремо й записується в `progress.md` і документацію, але `make check` його не обмежує.

### T15 · ESLint і граф бандла

- [ ] Наявна заборона прямих імпортів `@sentry/*` поза `sentry-service.ts` лишається; переконатися, що `check-bundle-graph` не потребує змін.
- [ ] `check-cold-start-budget`: додати `@sentry/*` до пакетів, заборонених у холодному старті.

### T16 · Тести

- [ ] Unit `src/utils/__tests__/sentry-service.spec.ts`:
    - вимкнено → `import('@sentry/vue')` не викликається, `init` завершується синхронно;
    - увімкнено → виклики до завантаження буферизуються й відтворюються;
    - переповнення буфера відкидає найстаріші;
    - помилка завантаження SDK не ламає застосунок і не блокує монтування.
- [ ] `e2e/sentry/**` зелені: наявний Replay-тест покриває маскування токена.
- [ ] Новий `e2e/sentry/early-errors.spec.ts`: помилка, кинута під час першого монтування Vue (тестовий компонент або хук у mock-збірці), доходить до Sentry-транспорту з тими самими тегами, що й зараз.
- [ ] Новий `e2e/sentry/first-navigation-trace.spec.ts`: транзакція першої навігації (`pageload`) відправляється і містить маршрут без query.
- [ ] Збірка з `VITE_SENTRY_ENABLED=false`: у мережевих запитах `/login` немає чанків Sentry (e2e).
- [ ] Збірка з увімкненим Sentry: мережевий розмір `/login` і затримку першого рендеру записати в `progress.md`.

### T17 · Замір і документація

- [ ] Замір до/після скриптом T2; знизити ліміт бюджету.
- [ ] `documentation/frontend/` (обидві локалі), сторінка про Sentry: SDK вантажиться динамічно, за ввімкненого Sentry монтування чекає на нього, ранні події буферизуються — компроміс описати явно.

---

## feat-281 · PWA-install: lazy-loading fallback

### T18 · Старт фічі

- [ ] Старт фічі.

### T19 · Динамічний імпорт `<pwa-install>`

**Зміни**

- [ ] `src/components/MenuButton.vue`: прибрати `import '@khmyznikov/pwa-install'` з рядка 2.
- [ ] `src/composables/usePwaInstallButton.ts` (або `utils/pwa-install.ts`): функція `ensurePwaInstallElement()` — `import('@khmyznikov/pwa-install')` один раз (memoized promise).
- [ ] **Точна умова імпорту** — чиста функція `shouldLoadPwaFallback`, у `progress.md` таблиця станів. Модуль вантажиться, лише якщо виконано все:
    - застосунок не встановлений (`!isAppInstalled`, як зараз у `shouldMountPwaInstall`);
    - подія `beforeinstallprompt` не перехоплена до цього моменту;
    - браузер її в принципі не підтримує: `'BeforeInstallPromptEvent' in window === false` (наявний `supportsNativeInstallPrompt`). Перевірено в Playwright: Chromium 156 — `true`, WebKit і Firefox — `false`.

    Поточний `shouldMountPwaInstall` перевіряє лише встановленість, тож його недостатньо. Не чекати подію доступності від самого компонента: поки модуль не завантажений, він її не надішле.

- [ ] **Момент імпорту.** За умовою `shouldLoadPwaFallback` — на `pointerenter` і `focus` кнопки меню (попереднє завантаження) та, як запасний варіант, на відкритті меню. Так пункт «Install App» не з'являється із затримкою всередині вже відкритого меню.
- [ ] `<pwa-install>` рендериться після завантаження модуля (`v-if` на стані завантаження).
- [ ] **Обробники подій.** `pwa-install-available-event`/`pwa-install-success-event` у [`usePwaInstallButton.ts`](../../packages/frontend/src/composables/usePwaInstallButton.ts) зараз підписуються в `onMounted`, коли елемента ще немає. Замінити на `watch` за ref `pwaInstall` (`flush: 'post'`):
    - підписка, коли елемент з'являється;
    - при заміні — відписка від старого й підписка на новий;
    - відписка, коли елемент зникає, і в `onUnmounted`.
- [ ] `initializePwaInstallTracking()` у `main.ts` і раннє відстеження `beforeinstallprompt` у `utils/pwa-install.ts` — без змін.

### T20 · Тести

- [ ] Unit:
    - `shouldLoadPwaFallback` за таблицею станів;
    - `ensurePwaInstallElement` імпортує модуль один раз при повторних наведеннях і відкриттях;
    - обробники підписуються при появі ref, переписуються при заміні елемента й відписуються при зникненні.
- [ ] e2e (mock, Chromium), **нативний prompt**:
    - регресія: `'BeforeInstallPromptEvent' in window === true`;
    - емульований `beforeinstallprompt` → пункт «Install App» працює через нативний prompt;
    - `@khmyznikov/pwa-install` не завантажується ні після наведення, ні після відкриття меню.
- [ ] e2e (mock, WebKit-проєкт Playwright), **без підтримки prompt**:
    - до наведення на кнопку меню модуля немає в запитах;
    - після наведення модуль завантажується;
    - після відкриття меню пункт «Install App» видно одразу, клік відкриває діалог `<pwa-install>`.

### T21 · Замір

- [ ] Замір до/після скриптом T2, знизити ліміт бюджету; `@khmyznikov/pwa-install`/`lit-html` додати до заборонених у холодному старті.

---

## feat-282 · Чистка CSS невеликими порціями

Кожна з T23–T25 — окремий коміт із власною візуальною перевіркою, щоб регресію було легко локалізувати.

### T22 · Старт фічі; локальна візуальна перевірка

Піксельні порівняння в постійному CI ненадійні: еталони з macOS і Linux розходяться через рендеринг шрифтів, `index.html` тягне зовнішній Google Fonts Inter, а `feat-285`/`feat-286` свідомо змінюватимуть пікселі. Тому візуальна перевірка — **локальна до/після всередині фічі**, не частина `test:e2e` і CI.

- [ ] Старт фічі.
- [ ] `playwright.visual.config.ts` + `e2e-visual/visual.spec.ts`:
    - `toHaveScreenshot` для ключових екранів: `/login`, акаунт, підтримка, адмінка (користувачі, аудит), відкрите меню;
    - light і dark, мобільний і десктопний viewport;
    - запити до `fonts.googleapis.com`/`fonts.gstatic.com` блокуються через `page.route`, щоб шрифт був системним і стабільним;
    - еталони — у git-ignored теці.
- [ ] pnpm-скрипт `test:visual` (не входить у `test:e2e` і `make check`).
- [ ] Порядок використання: еталони знімаються на базовому коміті фічі, порівняння — на тій самій машині після кожної порції. Вивід порівняння й перелік свідомих відмінностей — у `progress.md`.

### T23 · Boilerplate `base.css`/`main.css`

- [ ] Перенести в `styles.css` те, що реально потрібне (`#app` тощо), видалити `src/assets/base.css`, `src/assets/main.css` та імпорт у `main.ts:4`.
- [ ] Візуальна перевірка: очікувані відмінності (наприклад, `font-weight`, `a:hover`) переглянути вручну, перелік — у `progress.md`.

### T24 · Мертві класи `shared-components.css`

- [ ] Скрипт-пошук (одноразовий, у `progress.md` — команда і результат) класів без використання в `src/**/*.vue|ts`; видалити підтверджені мертві (37 з 43 за аналізом), лишити `badge`, `btn-*`, `form-field`, `form-input`; виправити коментар `Used by`.
- [ ] Візуальна перевірка без відмінностей.

### T25 · Мертві класи `styles.css`

- [ ] Те саме для `styles.css` (залишки чату: `.chat-container`, `.contacts`, `.chat-header`, `.unread-count`, `.typing-dots` тощо).
- [ ] Візуальна перевірка без відмінностей.

### T26 · Замір

- [ ] Розмір CSS до/після скриптом T2 у `progress.md`; знизити ліміт бюджету.

---

## feat-283 · Нативні діалоги → контекстний UX

### T27 · Старт фічі

- [ ] Старт фічі.

### T28 · `ConfirmDialog` у базі знань

- [ ] Розширити [`ConfirmDialog.vue`](../../packages/frontend/src/components/account/ConfirmDialog.vue). Зараз він приймає лише `title`, `text`, `confirmLabel`, `cancelLabel`; додати:
    - `variant?: 'primary' | 'danger'` (стиль кнопки підтвердження; за замовчуванням — поточний вигляд);
    - `busy?: boolean`: кнопки неактивні, `Escape` і клік по backdrop ігноруються, кнопка підтвердження показує стан виконання.
- [ ] Unit `ConfirmDialog.spec.ts`: за `busy` кнопки `disabled`, `Escape` і backdrop не емітять `cancel`; без `busy` — поведінка як зараз; `variant` міняє клас кнопки.
- [ ] `src/views/admin/AdminKnowledgeBaseView.vue:169`: замінити `confirm(...)` на `ConfirmDialog` (`variant="danger"`, `busy` на час видалення, текст з i18n з назвою статті як параметром).
- [ ] `ConfirmDialog.vue` поки лишається в `components/account/` — перенесення в спільний шар у `feat-285`.
- [ ] **Новий** e2e `e2e/mock/admin-knowledge-base.spec.ts` (окремого спеку бази знань немає: `admin-staff-mfa.spec.ts` і `admin-roles.spec.ts` лише відкривають `/admin/knowledge-base`): видалення через діалог, скасування `Escape`, фокус на безпечній дії, кнопки неактивні під час видалення. Цей спек далі використовується в T52.

### T29 · Помилка аватара біля поля

- [ ] `src/views/UserAccount.vue:241,246`: замість `window.alert` — повідомлення біля кнопки вибору файлу (`role="alert"` або `aria-describedby` на кнопці), скидається при новому виборі.
- [ ] e2e `account-profile.spec.ts`: завеликий файл і не-зображення показують повідомлення, модалка редактора не відкривається.

### T30 · Статус невдалого виходу

- [ ] `src/components/MenuButton.vue:88`: замість `window.alert(t('auth.logoutUnfinished'))` — видимий статус, що сесія досі активна (у меню або хедері, `role="status"`), з можливістю повторити вихід.
- [ ] e2e (mock), сценарій Р13 з [`useSessionLifecycle.ts`](../../packages/frontend/src/composables/useSessionLifecycle.ts):
    - `POST` logout на кожен повтор відповідає `503` з причиною `LOGOUT_RETRY_REASON` (`logout_retry`), доки не вичерпано `LOGOUT_RETRIES`;
    - `logoutSession()` повертає `kept`: статус «сесія досі активна» видно, користувач лишається в застосунку, WebSocket і дані не скинуті;
    - наступна спроба виходу з успішною відповіддю → статус зникає, перехід на `/login`.
- [ ] Відповідь `unknown` (інша помилка) статус «сесія активна» **не** показує — поведінка як зараз.
- [ ] `src/App.vue:233`: прибрати коментар-заглушку `<!-- Универсальные toast-уведомления -->` — від глобальних toast свідомо відмовилися.

### T31 · Заборона нативних діалогів

- [ ] `eslint.config.ts`: `no-alert: 'error'` для `src/**` (без тестів); `pnpm lint` зелений.

---

## feat-284 · Роутинг: catch-all разом із `meta.public`; дрібна гігієна

### T32 · Старт фічі

- [ ] Старт фічі.

### T33 · `meta.public` і `meta.scrollable`

- [ ] [`src/env.d.ts`](../../packages/frontend/src/env.d.ts) (там уже живе augmentation `declare module 'vue-router'` з `RouteMeta`): додати `public?: boolean` і `scrollable?: boolean`.
- [ ] `src/router/index.ts`: проставити `public: true` на всі маршрути з `PUBLIC_PATHS` (`/`, `/login`, `/register`, `/verify-email`, `/reset-password`, `/oauth/link/confirm`, `/about`, юридичні сторінки), `scrollable: true` — на юридичні сторінки.
- [ ] `App.vue`: `isScrollablePage` з `route.meta.scrollable`; видалити `SCROLLABLE_ROUTES`.

### T34 · Класифікація початкового URL через роутер

- [ ] `App.vue` `initializeApp`: замість `PUBLIC_PATHS.has(normalizeRoutePath(routePath))` — `router.resolve(normalizeRoutePath(routePath)).meta.public === true`; видалити `PUBLIC_PATHS`.
- [ ] Зберегти поведінку feat-211: `/Reset-Password/` — публічна сторінка; тест у `utils/__tests__/route-path.spec.ts` лишається, додати unit на нову класифікацію (`/Reset-Password/`, `/reset-password`, приватний шлях, невідомий шлях).

### T35 · Catch-all 404

- [ ] Маршрут `/:pathMatch(.*)*` → lazy `NotFoundView.vue` з `meta: { public: true }`, текст і посилання на головну з i18n.
- [ ] Невідомий шлях для анонімного користувача показує 404, а не редирект на `/login` (наслідок T34).
- [ ] e2e (mock): `/no-such-page` анонімно і автентифіковано → 404; `/account` анонімно → `/login?redirect=…`; `/Reset-Password/?token=…` лишається публічним.
- [ ] HTTP-статус 404 від сервера — поза scope (див. «Поза scope»).

### T36 · `beforeEach` без `next` і без `as never`

- [ ] `router/index.ts:179`: return-based guard (`return '/login?redirect=…'`, `return redirect`, `return true`); поведінка та наявні e2e (`unauthorized.spec.ts`, admin-редиректи, `sign-in-redirect` у live) без змін.
- [ ] `as never` у `router.beforeEach((to) => redirectWithoutUrlToken(to) as never)` (рядок 175) виникає через тип `query: Record<string, unknown>` у [`one-time-url-token.ts:118`](../../packages/frontend/src/utils/one-time-url-token.ts). Типізувати `query` як `LocationQueryRaw` із `vue-router` і прибрати каст; unit `one-time-url-token.spec.ts` зелений.

### T37 · `meta.title`, бренд у SW, документація

- [ ] `router/index.ts`: `meta.title` (англійські рядки) — видалити разом із полем `title` у `RouteMeta` і prop `title` в `AppHeader.vue`, які ніде не рендеряться; прибрати мертві стилі `.title-slot`, `.app-header h1`, `.nav-badge`. Якщо заголовок сторінки знадобиться — окрема задача з i18n-ключами.
- [ ] `src/service-worker.ts:466`: `'Easy Chat'` → `PRODUCT.name` із `shared/product` (перевірити, що імпорт допустимий у SW-збірці `vite.sw.config.ts` і не тягне runtime-схем).
- [ ] Прибрати `dompurify` з таблиці стеку в `documentation/frontend/index.md` і `documentation/en/frontend/index.md`; `pnpm docs:build && pnpm docs:verify`.

### T38 · Guard `matchMedia`

- [ ] `src/stores/state.ts`: `typeof window.matchMedia === 'function'` перед підписками; unit на ініціалізацію стору без `matchMedia`.

---

## feat-285 · Спільний каркас `UiModal`

### T39 · Старт фічі

- [ ] Старт фічі.

### T40 · Семантичні селектори e2e до зміни розмітки

Auth-спеки зав'язані на DOM-структуру `AuthModalShell`. [`e2e/mock/support.ts:183-184`](../../packages/frontend/e2e/mock/support.ts) шукає модалки як `.modal-overlay` `.nth(0)`/`.nth(1)`, а `modal-state.spec.ts` і `modal-keyboard.spec.ts` перевіряють `.modal-overlay.show`. `UiModal` на `v-if` + `Teleport` зламав би їх усі одразу.

- [ ] Перевести `loginModal`/`registerModal` у `support.ts` на `page.getByRole('dialog', { name: … })`, а перевірки `.modal-overlay.show` у `modal-state.spec.ts` і `modal-keyboard.spec.ts` — на видимість/кількість `getByRole('dialog')`.
- [ ] Пошук інших селекторів за класами модалок у `e2e/**`, `e2e-live/**`, `e2e-security/**` (команда й результат — у `progress.md`), переведення на ролі.
- [ ] Усі e2e зелені **на поточній розмітці** — окремий коміт до будь-яких змін модалок. `keepMounted` в `UiModal` тоді не потрібен.

### T41 · `UiModal` на двох різних діалогах

- [ ] `src/components/ui/UiModal.vue`: `Teleport` у `body`, backdrop, панель, `role` (`dialog` | `alertdialog`), `aria-modal`, `aria-labelledby`/`aria-describedby` через `useId()`, `useModalDialog`, слоти `header`/`default`/`footer`, розміри, єдина шкала `z-index` (CSS-токени).
- [ ] Перевести на нього рівно два діалоги з різною формою: `ConfirmDialog.vue` (разом із `busy`/`variant` з T28) і `AvatarEditorModal.vue`. За результатом — уточнити API (записати в `progress.md`, що змінилось).
- [ ] `ConfirmDialog.vue` → `src/components/ui/UiConfirmDialog.vue`; оновити імпорти (акаунт, база знань).
- [ ] Правило: `src/components/ui/**` не імпортує `stores/`, `utils/api*`, доменні типи — правило ESLint `no-restricted-imports` для цієї теки.

### T42 · Решта модалок, по 1–2 за коміт

- [ ] `ReauthDialog.vue`.
- [ ] `RoleChangeDialog.vue`, `MfaResetDialog.vue`.
- [ ] `AdminUserDetailModal.vue`.
- [ ] `AuthModalShell.vue` (останнім: найбільше e2e).

### T43 · Тести

- [ ] Unit `src/components/ui/__tests__/UiModal.spec.ts`: ARIA-атрибути, `Escape`, повернення фокуса, вкладені діалоги.
- [ ] `e2e/mock/modal-keyboard.spec.ts`, `modal-state.spec.ts` та e2e кожного переведеного діалогу зелені після кожного кроку T42.

### T44 · Документація

- [ ] `src/components/ui/README.md` (або сторінка в `documentation/frontend/`, обидві локалі): правила шару `ui/` з розділу 3 аналізу.

---

## feat-286 · Декомпозиція `UserAccount.vue`

### T45 · Старт фічі; еталони

- [ ] Старт фічі.
- [ ] Зняти еталони `test:visual` (T22) для екранів акаунта на базовому коміті фічі.

### T46 · Примітиви під першого споживача

- [ ] `src/components/ui/`: `UiButton.vue`, `UiField.vue`, `UiInput.vue`, `UiBadge.vue` (API з розділу 3 аналізу); unit на ARIA-зв'язки `UiField` (`aria-describedby`, `aria-invalid`) і `type="button"` за замовчуванням у `UiButton`.

### T47 · Секції, по одній за коміт

- [ ] `AccountAvatarSection` (разом з повідомленням про помилку з T29).
- [ ] `AccountProfileForm` (профіль, пошук таймзон).
- [ ] `AccountPasswordSection`.
- [ ] `AccountContactLinking` (email/телефон, OAuth-статус).
- [ ] `AccountAppearanceSettings` (тема, шрифт).
- [ ] Push-підписки і безпека — окремими секціями, якщо лишаються великими.
- [ ] Кожна секція використовує `UiButton`/`UiField`/`UiInput`; `UserAccount.vue` лишається тонким контейнером.

### T48 · Тести

- [ ] Після кожного кроку T47: `e2e/mock/account-profile.spec.ts`, `passkeys.spec.ts`, `mfa.spec.ts` зелені; unit для логіки, винесеної в composables.
- [ ] `test:visual` для акаунта на тій самій машині: без відмінностей або з переліком свідомих змін у `progress.md`.

### T49 · Підсумок

- [ ] Розмір `UserAccount.vue` до/після в `progress.md`.

---

## feat-287 · `SupportView` і великі адмін-сторінки

### T50 · Старт фічі; тести до рефакторингу

- [ ] Старт фічі.
- [ ] Нові e2e з T52 написати й зробити зеленими **на поточному коді**, окремим комітом до T51.

### T51 · Рефакторинг

- [ ] Винести стан і логіку чату зі `src/views/SupportView.vue` у `src/composables/useSupportChat.ts`; view лишається розміткою. Unit на composable: відправка, отримання, помилки, очищення підписок при розмонтуванні.
- [ ] `AdminKnowledgeBaseView.vue`: список/редактор/дії у composable + підкомпоненти.
- [ ] `AdminAuditLogView.vue`: фільтри й пагінація в composable + підкомпоненти.

### T52 · Тести

- [ ] Наявні спеки зелені: `e2e/mock/admin-audit-log.spec.ts`, `e2e-live/audit-log.spec.ts`, `e2e/mock/admin-knowledge-base.spec.ts` (створений у T28).
- [ ] **Нові тести** (окремих спеків для цих екранів немає; `e2e/mock/support.ts` і `e2e-live/support.ts` — допоміжні модулі, не спеки):
    - `e2e/mock/support.spec.ts`: відкриття чату, відправка повідомлення, отримання відповіді, стан помилки;
    - доповнити `e2e/mock/admin-knowledge-base.spec.ts`: список, створення, редагування статті.

### T53 · Підсумок

- [ ] Розміри файлів до/після в `progress.md`.

---

## Поза scope

Свідомі рішення; кожне з них можна підняти окремим `feat-XXX`, якщо зміняться умови.

- **`manualChunks`** у `vite.config.ts`. Після T3, T14 і T19 Rollup сам розділить більшу частину коду. Повертатися, лише якщо замір після `feat-281` покаже, що vendor-код і далі інвалідується разом з entry.
- **Прекомпіляція i18n** (`@intlify/unplugin-vue-i18n` + `__INTLIFY_DROP_MESSAGE_COMPILER__: true`, −41 KB). Окрема задача зі зміною формату локалей; простий прапорець зламає повідомлення з інтерполяцією.
- **`UiToastHost`**. Контекстні статуси (T29, T30) покривають наявні випадки; вводити, коли з'явиться споживач, якому вони не підходять.
- **HTTP 404 від сервера.** Окрема зміна SPA-fallback бекенду; T35 дає лише клієнтську сторінку 404.
- **`self.skipWaiting()`** лишається — рішення й обґрунтування в T6.
- **Очищення listener-ів** у `App.vue` (`matchMedia`), `stores/state.ts` (`resize`, `matchMedia`) і `useProfileSync` (`eventBus.on`). Реального витоку немає: кореневий `App`, Pinia-стор і `useProfileSync`, викликаний один раз з `App.vue`, живуть весь час роботи застосунку. Guard `matchMedia` для тестового оточення — у T38. Повертатися, якщо зміниться їхній життєвий цикл (наприклад, кілька екземплярів застосунку або HMR-проблеми).
