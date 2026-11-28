# Технічний аналіз `packages/frontend`

- **Дата:** 2026-11-28
- **Зріз репозиторію:** `main` @ `5aa41461`

## Загальна оцінка

`packages/frontend` — це SPA на **Vue 3.5 + TypeScript 6.0.3 + Pinia 4 + Vue Router 5 + Vite 7** із високим рівнем інженерної дисципліни у питаннях контрактів, безпеки, конкурентності та тестування. Водночас у кодовій базі накопичився помітний **бандл- та CSS-борг** від попередніх ітерацій шаблону, відсутній власний шар базових UI-примітивів, а частина сторінок і компонентів переросла в монолітні SFC.

---

## 1. Сильні сторони

### 1.1. Контрактний API/WS без витоку валідаторів у бандл (ADR 0005–0007)

- Усі HTTP- та WS-виклики проходять через типізовані контракти `shared/contracts`: [`api-client.ts`](../packages/frontend/src/utils/api-client.ts) (`callApi`, `contractUrl`) та [`ws-client.ts`](../packages/frontend/src/utils/ws-client.ts) (`callWs`).
- Скрипт [`check-bundle-graph.mjs`](../packages/frontend/scripts/check-bundle-graph.mjs) на рівні Rollup module graph перевіряє production-збірку та гарантує, що `arktype` і runtime-схеми `shared/schemas`/`shared/responses` не потрапляють у клієнтський бандл.
- [`eslint.config.ts`](../packages/frontend/eslint.config.ts) забороняє обхід контрактів (`fetch`, default-імпорт `base-api.ts`, `api.http`/`api.upload`, `websocketApi`), прямі імпорти `@sentry/*` поза [`sentry-service.ts`](../packages/frontend/src/utils/sentry-service.ts), імпорт `shared/*` у Vite-конфігах і приведення branded-типів (`local/no-brand-cast` + заборона `as` у `<template>`).
- У production-коді немає `v-html`/`innerHTML`, `@ts-ignore`, `@ts-expect-error` та `as any`.

### 1.2. Безпека, сесії та стійкість до race conditions

- **HTTP-транспорт і CSRF:** [`base-api.ts`](../packages/frontend/src/utils/base-api.ts) + [`csrf-token.ts`](../packages/frontend/src/utils/csrf-token.ts) реалізують cookie-сесії (`credentials: 'include'`), зберігання CSRF-токена лише в пам'яті з розділенням `confirmed`/`unconfirmed`, автомат станів `synced | reconciling | diverged | reloading`, single-flight рефреш, виявлення зміни обліковки в іншій вкладці та коректну обробку `401` під час ротації сесії (`renewsSession`).
- **Захист токенів і PII:** [`main.ts`](../packages/frontend/src/main.ts) прибирає одноразові `?token=` до старту роутера й Sentry ([`strip-url-token.ts`](../packages/frontend/src/utils/strip-url-token.ts)), а [`sentry-service.ts`](../packages/frontend/src/utils/sentry-service.ts) санітизує `beforeSend`, `beforeBreadcrumb`, `beforeSendSpan`, `maskReplayRecordingEvent` та `maskReplayEvent` із вимкненим збором PII (`dataCollection`).
- **Service Worker policy:** [`sw-request-policy.ts`](../packages/frontend/src/utils/sw-request-policy.ts) винесено в чисті модулі з unit-тестами — API та `no-store`/`private` відповіді ніколи не кешуються, а query-параметри прибираються з ключа кешування навігацій.
- **Конкурентний стан:** черга збереження профілю з `epoch` та `BigInt` revision у [`useProfileSave.ts`](../packages/frontend/src/composables/useProfileSave.ts), coalescing + `generation`/`seq` у [`notifications.ts`](../packages/frontend/src/stores/notifications.ts), `accessEpoch`/`accessReads` у [`user.ts`](../packages/frontend/src/stores/user.ts), WebSocket-singleton із `retiredSockets` і `suspendReconnect` у [`useWebSocketConnection.ts`](../packages/frontend/src/composables/useWebSocketConnection.ts).

### 1.3. DX, конфігурація збірки та тестування

- Єдине джерело `API_PATH_PREFIX`/`HOST`/`PORT` ([`vite.backend.ts`](../packages/frontend/vite.backend.ts)) + `build-meta.json` ([`vite.build-meta.ts`](../packages/frontend/vite.build-meta.ts)) + HMR напряму з `shared/src` ([`vite.shared-source.ts`](../packages/frontend/vite.shared-source.ts)) + єдиний брендинг для `index.html`, `manifest.json` і `robots.txt` ([`vite.product.ts`](../packages/frontend/vite.product.ts)) + вирізання `console.log/info/debug/trace` у production ([`vite.console.ts`](../packages/frontend/vite.console.ts)).
- Потужна піраміда тестів: **83** unit-спеки (Vitest + jsdom + Vue Test Utils), **20** Playwright e2e (у т.ч. окремі mock та Sentry replay збірки), **16** live-e2e, **2** security-e2e (CSRF, SW) та **1** CSP-e2e.

---

## 2. Технічні зауваження та борг

### 2.1. Монолітний початковий бандл (994 KB JS + 109 KB CSS)

Головний entry-чанк `dist/assets/index-*.js` важить **994 KB** (**313 KB gzip**), а `index-*.css` — **109 KB** (**18,6 KB gzip**); замір на `5aa41461`. Анонімний користувач на `/login` завантажує майже весь застосунок одразу.

Розміри в таблиці нижче — до мініфікації: вони допомагають знайти кандидатів на поділ, але економію підтверджує лише повторний замір збірки.

| Модуль / група в entry-чанку                                                    | Розмір (до мініфікації) | Причина потрапляння в entry                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sentry/*` (`@sentry/replay` 265 KB, `@sentry/core` 241 KB, `browser*` 141 KB) |                 ~664 KB | Статичний `import * as Sentry` у [`sentry-service.ts`](../packages/frontend/src/utils/sentry-service.ts) вантажиться навіть за `VITE_SENTRY_ENABLED=false`                                                      |
| `src/components` + `src/views`                                                  |                 ~333 KB | Статичний імпорт більшості сторінок (уся адмінка, `UserAccount`, `SupportView`, `VerifyEmailView`, `ResetPasswordView`, `OAuthLinkConfirmView`) у [`router/index.ts`](../packages/frontend/src/router/index.ts) |
| `@khmyznikov/pwa-install` + `lit-html`                                          |                 ~140 KB | Статичний side-effect `import '@khmyznikov/pwa-install'` у [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue), навіть коли встановлення недоступне                                          |
| `vue-advanced-cropper`                                                          |                   82 KB | Статичний імпорт [`AvatarEditorModal.vue`](../packages/frontend/src/components/AvatarEditorModal.vue) у статично імпортованому [`UserAccount.vue`](../packages/frontend/src/views/UserAccount.vue)              |
| `@intlify/message-compiler`                                                     |                   41 KB | `__INTLIFY_DROP_MESSAGE_COMPILER__: false` у [`vite.config.ts`](../packages/frontend/vite.config.ts)                                                                                                            |

> **Компілятор повідомлень не можна просто вимкнути.** Локалі вантажаться в рантаймі як TS-об'єкти (динамічний `import()` файлу `@/locales/<code>.ts` у [`plugins/i18n.ts`](../packages/frontend/src/plugins/i18n.ts)), тому `__INTLIFY_DROP_MESSAGE_COMPILER__: true` зламає повідомлення з інтерполяцією. Економія 41 KB можлива лише з прекомпіляцією повідомлень під час збірки (`@intlify/unplugin-vue-i18n`) — це окрема задача, а не прапорець.

Додатково у [`vite.config.ts`](../packages/frontend/vite.config.ts) відсутній `rollupOptions.output.manualChunks`, через що будь-яка зміна в `src/` інвалідує кеш усього entry-файлу. Після переведення маршрутів і Sentry на lazy-loading Rollup сам розділить більшу частину коду, тож ручні чанки дадуть мало й додадуть підтримки — до них варто повертатися лише після повторного заміру.

Також немає бюджету розміру: [`check-bundle-graph.mjs`](../packages/frontend/scripts/check-bundle-graph.mjs) перевіряє склад графа, але не розмір, тож бандл може непомітно вирости знову. Міряти варто не entry-чанк, а **суму JS і CSS, потрібних для холодного відкриття `/login`**: entry, його статичні залежності та активну локаль. Інакше перенесення коду в інший статично імпортований файл покращить цифру entry без жодного виграшу для користувача.

### 2.2. CSS-спадщина, мертвий код і конфлікт каскаду

У [`main.ts`](../packages/frontend/src/main.ts) підключено 4 глобальні шари стилів плюс unscoped `<style>` у [`App.vue`](../packages/frontend/src/App.vue):

1. [`src/assets/base.css`](../packages/frontend/src/assets/base.css) та [`src/assets/main.css`](../packages/frontend/src/assets/main.css) — незайманий boilerplate від `create-vue` (`--vt-c-*`, `.green`, `a:hover { background-color: hsla(160, 100%, 37%, 0.2) }`, `*, *::before, *::after { font-weight: normal }`), що конфліктує з дизайн-токенами в `styles.css`.
2. [`src/shared-components.css`](../packages/frontend/src/shared-components.css) (752 рядки, коментар `Used by: Notes, Calendar`) — **37 із 43 класів не використовуються** (`.page-manager`, `.item-card`, `.badge-priority` тощо). У коді зустрічаються лише 6 класів (`badge`, `btn-primary`, `btn-secondary`, `btn-danger`, `form-field`, `form-input`).
3. [`src/styles.css`](../packages/frontend/src/styles.css) (897 рядків) — **20 із 40 класів мертві** (залишки попереднього чату: `.chat-container`, `.contacts`, `.chat-header`, `.unread-count`, `.typing-dots` тощо).
4. У [`App.vue`](../packages/frontend/src/App.vue) глобально зафіксовано `html, body { position: fixed; height: 100dvh; overflow: hidden; }`, що вимикає нативний скрол і змушує тримати окремий список `SCROLLABLE_ROUTES`.

Глобальні стилі задають базову поведінку каскаду для всіх екранів, тому прибирати їх треба невеликими порціями зі скриншотами ключових екранів, а не одним PR.

### 2.3. Відсутність шару базових UI-примітивів

У пакеті немає ані зовнішньої UI-бібліотеки, ані внутрішньої папки `src/components/ui/`:

- Кнопки, поля вводу та бейджі стилізуються фрагментарно: частина бере глобальні класи зі `shared-components.css`, частина — доменні таблиці ([`auth-forms.css`](../packages/frontend/src/assets/auth-forms.css), [`admin.css`](../packages/frontend/src/assets/admin.css)), частина — дублює власні `.secondary-button`/`.danger-button` у `<style scoped>` (наприклад, [`ConfirmDialog.vue`](../packages/frontend/src/components/account/ConfirmDialog.vue)).
- Єдиний headless composable [`useModalDialog.ts`](../packages/frontend/src/composables/useModalDialog.ts) якісно закриває клавіатурну поведінку (focus trap, стек діалогів, `Escape`, повернення фокуса), але каркас модалки (overlay, backdrop, panel, ARIA-атрибути, `z-index`, стилі) **дублюється щонайменше в 7 компонентах**:
    - [`AuthModalShell.vue`](../packages/frontend/src/components/auth/AuthModalShell.vue)
    - [`ConfirmDialog.vue`](../packages/frontend/src/components/account/ConfirmDialog.vue)
    - [`ReauthDialog.vue`](../packages/frontend/src/components/account/ReauthDialog.vue)
    - [`AvatarEditorModal.vue`](../packages/frontend/src/components/AvatarEditorModal.vue)
    - [`AdminUserDetailModal.vue`](../packages/frontend/src/components/admin/AdminUserDetailModal.vue)
    - [`RoleChangeDialog.vue`](../packages/frontend/src/components/admin/RoleChangeDialog.vue)
    - [`MfaResetDialog.vue`](../packages/frontend/src/components/admin/MfaResetDialog.vue)
- [`ConfirmDialog.vue`](../packages/frontend/src/components/account/ConfirmDialog.vue) лежить у доменній теці `components/account/`, через що інші частини застосунку його не перевикористовують. Водночас він уже готовий до перевикористання: має `role="alertdialog"`, початковий фокус на безпечній дії (`data-modal-initial-focus`) і спільну клавіатурну логіку `useModalDialog`.

### 2.4. Перевантажені SFC-компоненти («God components»)

- [`UserAccount.vue`](../packages/frontend/src/views/UserAccount.vue) — **1205 рядків** (аватар, профіль і пошук таймзон, зміна пароля, прив'язка email/телефону, OAuth-статус, тема/шрифт, push-підписки, безпека).
- [`SupportView.vue`](../packages/frontend/src/views/SupportView.vue) — **840 рядків**.
- [`AdminKnowledgeBaseView.vue`](../packages/frontend/src/views/admin/AdminKnowledgeBaseView.vue) — **764 рядки**.
- [`AdminAuditLogView.vue`](../packages/frontend/src/views/admin/AdminAuditLogView.vue) — **679 рядків**.
- [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue) — **640 рядків**.
- [`Login.vue`](../packages/frontend/src/views/Login.vue) — **599 рядків**.

### 2.5. Прогалини в i18n, доступності (a11y) та UX-консистентності

- **Хардкод англійських рядків поза `vue-i18n`:**
    - [`AppHeader.vue`](../packages/frontend/src/components/AppHeader.vue): `'Connected'`, `'Connecting...'`, `'Disconnected'`, `'Unknown'`, `Back`, `Support`, `WebSocket Status: ...`.
    - [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue): `Navigation` та частина пунктів меню.
    - [`PwaInstallButton.vue`](../packages/frontend/src/components/PwaInstallButton.vue): `Install App`.
    - [`router/index.ts`](../packages/frontend/src/router/index.ts): `meta.title` містить англійські рядки, при цьому prop `title` в [`AppHeader.vue`](../packages/frontend/src/components/AppHeader.vue) взагалі не рендериться в шаблоні (а стилі `.title-slot`, `.app-header h1`, `.nav-badge` — мертві).
- **Нативні блокуючі діалоги браузера:**
    - `window.alert(...)` у [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue) та [`UserAccount.vue`](../packages/frontend/src/views/UserAccount.vue).
    - `confirm(...)` у [`AdminKnowledgeBaseView.vue`](../packages/frontend/src/views/admin/AdminKnowledgeBaseView.vue) попри наявність `ConfirmDialog.vue`.
    - Глобальної toast-системи немає (у [`App.vue`](../packages/frontend/src/App.vue) лишився лише коментар-заглушка).
- **A11y:**
    - Кнопка гамбургера в [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue) не має доступної назви, `aria-expanded`, `aria-haspopup` та закриття по `Escape` з поверненням фокуса.
    - Згорнуті секції меню (`.group-items` без `.expanded`) приховані лише висотою та `overflow: hidden`, тому їхні кнопки можуть лишатися в порядку табуляції.
    - Кнопка Back в [`AppHeader.vue`](../packages/frontend/src/components/AppHeader.vue) ховає `<span>Back</span>` на мобільних через `display: none` без `aria-label` на самій кнопці.

### 2.6. Роутинг, Service Worker і життєвий цикл підписок

- **Роутинг ([`router/index.ts`](../packages/frontend/src/router/index.ts)):**
    - Немає catch-all маршруту `404` (`/:pathMatch(.*)*`).
    - `router.beforeEach(async (to, _from, next) => ...)` використовує застарілий у Vue Router 5 callback-стиль `next()`.
    - `PUBLIC_PATHS` і `SCROLLABLE_ROUTES` у [`App.vue`](../packages/frontend/src/App.vue) дублюють конфігурацію роутера замість використання `route.meta`.
    - **Catch-all і `PUBLIC_PATHS` пов'язані.** `initializeApp` в [`App.vue`](../packages/frontend/src/App.vue) після `401` перенаправляє анонімного користувача на `/login` для будь-якого шляху поза `PUBLIC_PATHS`, тож сам catch-all анонімному користувачу 404 не покаже. Їх треба змінювати разом: класифікувати початковий URL через явно розв'язаний маршрут (`router.resolve(...)` + `meta.public`) і зберегти тест на `/Reset-Password/` (feat-211, [`route-path.spec.ts`](../packages/frontend/src/utils/__tests__/route-path.spec.ts)). Справжній HTTP-статус 404 — окрема зміна серверного SPA-fallback.
- **Service Worker ([`service-worker.ts`](../packages/frontend/src/service-worker.ts)):**
    - Автоматичний `self.skipWaiting()` в `install` + `self.clients.claim()` та видалення старих кешів в `activate`. Головне джерело 404 для lazy-чанків у вже відкритих вкладках — не SW, а сам деплой: на сервері більше немає файлів зі старими хешами. SW уже надсилає `NEW_VERSION`, який обробляє [`sw-manager.ts`](../packages/frontend/src/utils/sw-manager.ts). Бракує обробника `vite:preloadError` (одноразовий reload із захистом від циклу); він стає обов'язковим разом із lazy-loading маршрутів. Прибирати `skipWaiting()` для цього не потрібно. Старі чанки після деплою не переживуть і на сервері: [`Dockerfile`](../Dockerfile) копіює в образ `dist` лише однієї збірки (`packages/frontend/dist` → `packages/backend/public`), а новий SW видаляє попередні кеші. Подія `vite:preloadError` охоплює й інші причини збою імпорту (офлайн, тимчасовий збій мережі), тому обробник не повинен безумовно перезавантажувати сторінку.
    - Залишковий хардкод бренду `'Easy Chat'` як fallback-заголовка push-сповіщень замість `PRODUCT.name` із `shared/product`.
- **Listener-и без очищення (низький пріоритет — реального витоку немає):**
    - `matchMedia('(prefers-color-scheme: dark)').addEventListener` у [`App.vue`](../packages/frontend/src/App.vue) без `removeEventListener`, але кореневий `App` живе весь час роботи застосунку.
    - `window.addEventListener('resize', ...)` і два `matchMedia.addEventListener` у [`stores/state.ts`](../packages/frontend/src/stores/state.ts) — Pinia-стор теж живе весь час роботи застосунку. Корисне тут лише guard `typeof window.matchMedia === 'function'` для тестового оточення.
    - `eventBus.on(...)` у `useProfileSync` ([`useProfileSave.ts`](../packages/frontend/src/composables/useProfileSave.ts)) викликається один раз із кореневого `App.vue`, тож повторної підписки не відбувається.
- **Дрейф документації:** у [`documentation/frontend/index.md`](../documentation/frontend/index.md) (і англійській версії) у таблиці стеку досі вказано `dompurify`, якого немає в [`packages/frontend/package.json`](../packages/frontend/package.json).

---

## 3. Рекомендований власний шар базових UI-примітивів (`src/components/ui/`)

Оскільки шаблон свідомо уникає важких зовнішніх UI-фреймворків (що дає повний контроль над бандлом, стилями й відсутність vendor lock-in), оптимальне рішення — створити легкий внутрішній шар у `src/components/ui/` поверх наявних CSS-токенів із [`styles.css`](../packages/frontend/src/styles.css) і готової логіки [`useModalDialog.ts`](../packages/frontend/src/composables/useModalDialog.ts).

### Пропонований мінімальний набір примітивів

| Компонент             | Відповідальність та API                                                                                                                                                                                                     | Що замінює / уніфікує                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `UiModal.vue`         | `<Teleport to="body">`, backdrop, панель, `role="dialog" \| "alertdialog"`, `aria-modal`, `useId()` для заголовка, `useModalDialog`, слоти `header` / `default` / `footer`, розміри `sm \| md \| lg`, єдина шкала `z-index` | Усуває ~7 дубльованих реалізацій overlay/panel (`AuthModalShell`, `ConfirmDialog`, `ReauthDialog`, `AvatarEditorModal`, адмінські модалки) |
| `UiConfirmDialog.vue` | Обгортка поверх `UiModal` з `role="alertdialog"`, початковим фокусом на безпечній дії (`data-modal-initial-focus`), варіантом `danger \| primary`, підтримкою стану `busy`                                                  | Переносить `components/account/ConfirmDialog.vue` у спільний шар і прибирає `confirm()` в `AdminKnowledgeBaseView.vue`                     |
| `UiButton.vue`        | Варіанти `primary \| secondary \| danger \| ghost`, розміри `sm \| md`, пропси `loading`, `disabled`, `type` (за замовчуванням `'button'`), підтримка іконкового слота                                                      | Прибирає розкидані `.btn-*`, `.secondary-button`, `.danger-button` та дублювання hover/focus/disabled станів                               |
| `UiField.vue`         | Обгортка поля форми: `label`, зв'язування через `useId()`, підказка (`hint`), повідомлення про помилку (`error` + `aria-describedby` / `aria-invalid`)                                                                      | Уніфікує форми в `auth/`, `UserAccount.vue` та адмінці                                                                                     |
| `UiInput.vue`         | Базовий інпут (`v-model`), прозорий прокид атрибутів, стилі помилки/фокусу/disabled на дизайн-токенах                                                                                                                       | Замінює ручні класи `.form-input` і дублі в `auth-forms.css` / `admin.css`                                                                 |
| `UiBadge.vue`         | Статусні бейджі (`neutral \| info \| success \| warning \| danger`) на семантичних токенах `--*-color` / `--*-bg`                                                                                                           | Уніфікує статуси ролей, сесій, MFA, WebSocket та аудит-логу                                                                                |
| `UiToastHost.vue`     | Неблокуюча черга сповіщень (`useToast()` composable + `role="status"` / `aria-live="polite"`) з авто-закриттям і кнопкою dismiss                                                                                            | Закриває заглушку в `App.vue`; вводити лише коли з'явиться споживач, для якого не підходить повідомлення біля поля або видимий статус      |

### Правила проєктування шару `ui/`

1. **Без доменної логіки й API-викликів:** компоненти `ui/` не імпортують `stores/`, `utils/api.ts` або доменні типи; максимум — `useModalDialog`, `useId` і CSS-токени.
2. **Контракт через CSS-токени:** жодних захардкоджених hex-кольорів (лише `--bg-*`, `--text-*`, `--accent-*`, `--danger-*`, `--border-color`, `--radius-*`), щоб усі 6 колірних тем і dark/light режим працювали автоматично.
3. **A11y за замовчуванням:** `type="button"` у `UiButton`, `aria-labelledby`/`aria-describedby` через `useId()` у `UiModal`/`UiField`, видимий `:focus-visible`, підтримка `Escape` і focus-trap.
4. **Поступова міграція без «великого вибуху», лише під конкретних споживачів:**
    - Почати з перевикористання наявного `ConfirmDialog.vue` у базі знань замість `confirm()`.
    - `window.alert()` замінювати за контекстом, а не одним toast: помилка вибору аватара — повідомлення біля поля; невдалий вихід — видимий статус, що сесія досі активна.
    - Спільний каркас `UiModal` виділяти лише після того, як його API перевірено на двох різних діалогах (наприклад, `ConfirmDialog` і `AvatarEditorModal`); далі переводити решту модалок по 1–2 за PR, бо вони вже покриті e2e.
    - `UiButton`/`UiField`/`UiInput`/`UiBadge`/`UiToastHost` не створювати наперед, а вводити разом із декомпозицією `UserAccount.vue` і адмінки, щоб шар не з'явився без споживачів.
5. **Закріпити лінтером:** увімкнути `no-alert` в [`eslint.config.ts`](../packages/frontend/eslint.config.ts), так само як уже заборонено обхід контрактів.

---

## 4. Пріоритизований план робіт

Кожен пункт — окремий `feat-XXX` у `feature_list.json`. Покроковий task list: [`plan/frontend-tasks.md`](./plan/frontend-tasks.md). Порядок враховує залежності між задачами. Першими йдуть п. 1 і, паралельно, п. 2.

### Пріоритет 1 — Початкове завантаження й оновлення

1. **Lazy-loading маршрутів + перехід між збірками + бюджет холодного старту.**
    - Винести важкі маршрути (акаунт, підтримка, адмінка, verify/reset/OAuth) у `() => import(...)` у [`router/index.ts`](../packages/frontend/src/router/index.ts); [`AvatarEditorModal.vue`](../packages/frontend/src/components/AvatarEditorModal.vue) завантажувати при відкритті (`defineAsyncComponent`).
    - Обробник `vite:preloadError`: одноразовий reload із захистом від циклу, а якщо повторна спроба не допомогла — видиме повідомлення замість нескінченного перезавантаження.
    - До злиття перевірити сценарій «вкладка зі збіркою A → деплой B → перший вхід у відкладений маршрут» (образ містить `dist` лише однієї збірки, новий SW чистить старі кеші). Окремо перевірити офлайн і тимчасовий збій мережі, бо подія охоплює різні причини помилки імпорту.
    - Бюджет у `make check`: сума JS і CSS для холодного відкриття `/login` (entry + статичні залежності + активна локаль), gzip.
2. **Клавіатурна навігація та переклади в хедері (невеликий окремий PR, паралельно з п. 1).**
    - Локалізовані доступні назви для гамбургера та мобільної кнопки Back в [`MenuButton.vue`](../packages/frontend/src/components/MenuButton.vue) і [`AppHeader.vue`](../packages/frontend/src/components/AppHeader.vue).
    - Решта хардкод-рядків у `AppHeader.vue`, `MenuButton.vue` і [`PwaInstallButton.vue`](../packages/frontend/src/components/PwaInstallButton.vue) — у `vue-i18n` у тому ж PR, щоб ці файли й e2e-селектори змінювалися один раз.
    - `aria-expanded`, закриття меню через `Escape` з поверненням фокуса на гамбургер.
    - Згорнуті секції меню виключити з порядку табуляції (`inert` або `v-show`) і перевірити, що `Tab` їх оминає.
3. **Sentry: lazy-loading SDK (окремий PR).**
    - Перевести `@sentry/vue` (+ окремо `replayIntegration`) на динамічний `import()` за фасадом [`sentry-service.ts`](../packages/frontend/src/utils/sentry-service.ts); статичні споживачі (`stores/user.ts`, `useWebSocketConnection.ts`, `main.ts`) лишаються, `captureException`/`setUser` буферизуються до завантаження SDK.
    - Sentry зараз ініціалізується до `app.mount`. Перевірити два режими: вимкнена конфігурація обходиться без завантаження SDK; увімкнена зберігає ранні помилки, трасування та маскування в Replay.
4. **PWA-install: lazy-loading fallback (окремий PR).**
    - Залишити раннє відстеження `beforeinstallprompt` у [`utils/pwa-install.ts`](../packages/frontend/src/utils/pwa-install.ts).
    - `@khmyznikov/pwa-install` завантажувати через `import()` при відкритті меню на браузерах без нативного prompt. Не чекати, поки компонент сам повідомить про доступність: у таких браузерах доступність визначає сам `<pwa-install>`, тож його імпорт так і не почнеться.

### Пріоритет 2 — CSS, діалоги, роутинг

5. **Чистка CSS невеликими порціями.** Кожна порція — окремий PR зі скриншотами ключових екранів до і після: boilerplate `src/assets/base.css`/`main.css`, мертві класи `shared-components.css`, мертві класи `styles.css`.
6. **Нативні діалоги → контекстний UX.**
    - Перевикористати `ConfirmDialog.vue` в [`AdminKnowledgeBaseView.vue`](../packages/frontend/src/views/admin/AdminKnowledgeBaseView.vue) замість `confirm()` (заразом прибравши неперекладений рядок `Delete "…"?`).
    - Помилку аватара в `UserAccount.vue` показувати біля поля; для невдалого виходу в `MenuButton.vue` — видимий статус, що сесія досі активна.
    - Увімкнути `no-alert` в ESLint.
7. **Роутинг: catch-all разом із перенесенням `PUBLIC_PATHS` у `meta`; дрібна гігієна.**
    - Додати `/:pathMatch(.*)*`, класифікувати початковий URL в `initializeApp` через `router.resolve(...)` + `meta.public` (зберегти тест на `/Reset-Password/`), `SCROLLABLE_ROUTES` → `meta.scrollable`, `router.beforeEach` → return-based API. HTTP 404 від сервера — поза scope, окрема зміна SPA-fallback.
    - Прибрати невикористаний `meta.title` і prop `title` в `AppHeader.vue` разом із мертвими `.title-slot`/`.nav-badge`.
    - Замінити `'Easy Chat'` у [`service-worker.ts`](../packages/frontend/src/service-worker.ts) на `PRODUCT.name`.
    - Прибрати `dompurify` з [`documentation/frontend/index.md`](../documentation/frontend/index.md) та [`documentation/en/frontend/index.md`](../documentation/en/frontend/index.md).
    - Додати guard `typeof window.matchMedia === 'function'` у [`stores/state.ts`](../packages/frontend/src/stores/state.ts).

### Пріоритет 3 — Декомпозиція й UI-примітиви під конкретних споживачів

8. **Спільний каркас `UiModal`** — після того, як його API перевірено на двох різних діалогах; потім переведення решти модалок по 1–2 за PR.
9. **Декомпозиція `UserAccount.vue`** на секційні компоненти (`AccountProfileForm`, `AccountAppearanceSettings`, `AccountAvatarSection`, `AccountPasswordSection`, `AccountContactLinking`) разом із `UiButton`, `UiField`, `UiInput`, `UiBadge` — нові секції стають їхніми першими споживачами.
10. **Винести чат-логіку** зі [`SupportView.vue`](../packages/frontend/src/views/SupportView.vue) у composable `useSupportChat.ts`; за тим самим підходом — `AdminKnowledgeBaseView.vue` і `AdminAuditLogView.vue`.

### Відкладено / за потреби

- `manualChunks` у [`vite.config.ts`](../packages/frontend/vite.config.ts) — лише якщо повторний замір після п. 1, 3, 4 покаже, що vendor-код і далі інвалідується разом з entry.
- Прекомпіляція повідомлень i18n через `@intlify/unplugin-vue-i18n` + `__INTLIFY_DROP_MESSAGE_COMPILER__: true` (−41 KB) — окрема задача зі зміною формату локалей.
- `UiToastHost` — коли з'явиться споживач, для якого не підходять повідомлення біля поля чи видимий статус.
- HTTP 404 від серверного SPA-fallback.
- Очищення listener-ів в `App.vue`, `stores/state.ts`, `useProfileSync` — реального витоку немає (усі живуть весь час роботи застосунку), тож лише якщо зміниться їхній життєвий цикл.
