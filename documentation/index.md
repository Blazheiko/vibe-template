---
layout: home

hero:
    name: vibe-template
    text: Full-stack TypeScript шаблон
    tagline: Готовий шаблон для швидкого старту розробки застосунків з AI-агентами. Строга типізація, перевірки й правила роботи тримають агента в рамках, тому він помиляється рідше, а свої помилки бачить сам.
    image:
        src: /logo.svg
        alt: vibe-template
    actions:
        - theme: brand
          text: Почати
          link: /guide/getting-started
        - theme: alt
          text: Як влаштований бекенд
          link: /guide/how-backend-works
        - theme: alt
          text: GitHub
          link: https://github.com/Blazheiko/vibe-template

features:
    - icon: 🔐
      title: Акаунти та вхід
      details: Реєстрація по email і телефону, підтвердження пошти, вхід через Google, GitHub, GitLab і Facebook, скидання пароля, вихід з усіх пристроїв.
      link: /backend/auth
    - icon: ⚡
      title: Швидкий бекенд на uWebSockets.js
      details: HTTP і WebSocket в одному процесі. Код розкладено шарами route → controller → service → repository, тому зрозуміло, куди що писати.
      link: /backend/architecture
    - icon: 🛡️
      title: Безпека з коробки
      details: Сесії в Redis, CSRF, CORS, CSP і security-заголовки, rate limiting, захист від перебору паролів, довірені проксі.
      link: /backend/security
    - icon: 🔄
      title: Real-time
      details: WebSocket-канал з авторизацією, хто онлайн, історія онлайну, push від сервера до клієнта.
      link: /backend/websocket
    - icon: 🔔
      title: Web Push повідомлення
      details: Підписка на push у браузері, збереження підписок і відправка через VAPID вже вбудовані. Ключі генерує одна команда pnpm push:vapid.
      link: /backend/web-push-notification
    - icon: 📱
      title: Інсталяція PWA
      details: Застосунок встановлюється на телефон і комп'ютер як нативний. Є маніфест, іконки, splash-екран, Service Worker з офлайн-кешем і повідомлення про нову версію.
      link: /frontend/#pwa
    - icon: 🤝
      title: Спільні контракти
      details: Пакет shared з arktype-схемами, enum-ами і типами відповідей. Якщо змінити спільний тип, TypeScript покаже, де фронтенд і бекенд з ним розійшлися.
      link: /shared/
    - icon: 🛠️
      title: Адмін-панель
      details: Список користувачів, хто зараз онлайн, історія онлайну і редактор бази знань для AI-чату. Окремий layout і доступ тільки для адміністраторів.
      link: /frontend/
    - icon: 🌍
      title: Мови й теми оформлення
      details: Інтерфейс перекладено vue-i18n англійською, українською й польською; AI-підтримка розпізнає 18 мов. Світла й темна тема та кольорові палітри Ocean, Mint, Lavender, Rose, Sunset і Monochrome.
      link: /frontend/#i18n
    - icon: 📁
      title: Файли й пошта
      details: Завантаження файлів у будь-яке S3-сумісне сховище (AWS, MinIO, DigitalOcean Spaces). SMTP-листи для підтвердження пошти й скидання пароля.
      link: /backend/storage
    - icon: 🧪
      title: API Playground
      details: Окремий застосунок для локальної розробки, який показує всі HTTP- і WebSocket-маршрути бекенду і дає викликати їх вручну.
      link: /playground/
    - icon: 🤖
      title: AI-чат підтримки
      details: Чат, який відповідає з бази знань (pgvector), адмінка промптів, облік токенів, провайдери OpenAI, xAI і Mistral.
      link: /backend/ai
---

## Що таке цей шаблон

**vibe-template** — це готовий шаблон для швидкого старту розробки застосунків **за допомогою AI-агентів** (Claude Code, Codex, Cursor та інших). Агент пише код швидко, але так само швидко може написати код, який лише виглядає правильним. Шаблон тримає агента в строго типізованому середовищі: компілятор, лінтер і тести архітектури ловлять більшість таких помилок одразу, і агент виправляє їх сам, ще до того як код дійде до вас на рев'ю. Чому це працює — у розділі [Чому шаблон підходить для агентної розробки](#чому-шаблон-підходить-для-агентноі-розробки).

Це не порожній «скелет», а **робочий застосунок**, з якого ви починаєте свій продукт. Зазвичай перші тижні нового проєкту йдуть на одне й те саме: реєстрація, логін, скидання пароля, сесії, CSRF, завантаження файлів, листи, push, адмінка, деплой. У цьому шаблоні все це вже написано, покрито тестами та задокументовано. Ви клонуєте репозиторій, налаштовуєте `.env` і одразу пишете **свою** бізнес-логіку.

Шаблон складається з трьох пакетів в одному репозиторії (pnpm workspace):

| Пакет      | Що це                                                               | Документація               |
| ---------- | ------------------------------------------------------------------- | -------------------------- |
| `backend`  | API-сервер і WebSocket на TypeScript + uWebSockets.js               | [Огляд бекенду](/backend/) |
| `frontend` | SPA/PWA на Vue 3 з Pinia, vue-router і vue-i18n                     | [Фронтенд](/frontend/)     |
| `shared`   | Схеми, типи та enum-и, які однаково імпортують і фронтенд, і бекенд | [Пакет shared](/shared/)   |

::: tip Новачок у проєкті?
Почніть з [Вступу](/guide/introduction), далі [Швидкий старт](/guide/getting-started) — локальний запуск за 10 хвилин. Потім прочитайте [Як влаштований бекенд](/guide/how-backend-works): там простими словами пояснено, що відбувається з запитом і навіщо кожен шар.
:::

## Що змінюється в ролі розробника

Шаблон переносить контроль із коду на **контракти**. Агент пише реалізацію й одразу отримує зворотний зв'язок від фреймворку: чи не порушено контракти, чи на місці шари, чи проходять тести. Тому вам не потрібно читати кожен рядок згенерованого коду. Головну увагу варто приділяти трьом контрактам:

1. **Що надходить на бекенд.** Схеми запитів у `shared` визначають, які дані приймає маршрут. `validator` на маршруті необов'язковий: маршрут без нього приймає будь-яке тіло, тож перевіряйте, що він стоїть там, де маршрут читає вхідні дані.
2. **Що віддає бекенд.** Маршрут з `ResponseSchema` перевіряє кожну свою відповідь (як саме — [аргумент 5](#чому-шаблон-підходить-для-агентної-розробки) нижче).
3. **Схему бази даних.** Drizzle-схема та міграції задають структуру даних, від якої залежить усе інше.

Три контракти не описують **доступ до маршрутів**: які middleware, guards і ліміти стоять на групі чи маршруті, видно в `http-routes.ts` і `ws-routes.ts`, а частину правил перевіряє `route-access.spec.ts`. Ці файли теж потребують уваги на рев'ю.

Правильність бізнес-логіки перевіряють **тести**: якщо поведінка описана тестом і тест зелений, рев'ю може зосередитися на тестах і контрактах, а не на кожному рядку реалізації. Рев'ю людиною лишається обов'язковим ([`AGENTS.md`](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md), Definition of Done), і зміна тестів потребує рев'ю так само, як зміна коду: послаблений тест пропускає те, що мав ловити.

## Чому шаблон підходить для агентної розробки

**Теза.** Агент найкраще працює там, де помилку видно відразу й однозначно. Людина помічає невідповідність з досвіду, а агент — тільки з того, що повернули компілятор, лінтер і тести. Тому що суворіші автоматичні перевірки, то менше помилок агента доходить до людини. Шаблон зроблено саме так: більшість типових помилок агента тут перетворюється на червоний `pnpm typecheck`, `pnpm lint` або `pnpm test`, і агент виправляє їх у тому ж циклі.

**Аргументи.**

1. **Строгий компілятор не дає «вгадувати».** Бекенд і `shared` збираються з [`tsconfig.base.json`](https://github.com/Blazheiko/vibe-template/blob/main/tsconfig.base.json), де крім `strict` увімкнено `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` і `noImplicitReturns`. Звернення до елемента масиву, який може бути відсутнім, або до поля, якого немає в типі, — це помилка компіляції, а не `undefined` у продакшені. Фронтенд перевіряється `vue-tsc` у режимі `strict`.
2. **Лінтер закриває обхідні шляхи.** У [`eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/eslint.config.ts) підключено `strictTypeChecked`, заборонено `any` і всі `no-unsafe-*` операції, вимагаються явні типи повернення, `strict-boolean-expressions` і `switch-exhaustiveness-check`. Агент не може «заглушити» тип через `any`, а додавши нове значення в enum, отримає помилку в кожному `switch`, який його не обробляє.
3. **Один контракт на дві сторони.** Схеми API описано один раз arktype у пакеті `shared`, структуру БД — один раз Drizzle-схемою. Коли агент змінює контракт, `pnpm typecheck` показує всі місця на бекенді й фронтенді, які треба оновити (приклад — [нижче](#змінили-контракт-—-typescript-показав-що-зламалось)). Агенту не треба пам'ятати, хто ще використовує тип: список дає компілятор.
4. **Архітектура перевіряється тестами, а не домовленістю.** [`layering.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/layering.spec.ts) падає, якщо контролер імпортує репозиторій напряму або сервіс звертається до БД в обхід репозиторію. [`route-access.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-access.spec.ts) перевіряє, що маршрути адмінки й push мають guard-и, а схеми відповідей описують реальний JSON. Агент, який зрізав кут, дізнається про це з тесту.
5. **Відповіді сервера перевіряються під час роботи.** Маршрут з `ResponseSchema` перевіряє кожну відповідь за цією схемою, і схема працює як allow-list полів. У розробці, CI і e2e діє режим `strict`: якщо агент забув поле, помилився з типом або випадково віддав зайве поле (наприклад, хеш пароля з рядка БД), запит падає з `500` і помилкою в лозі. У production за замовчуванням діє `log`: зайві поля вирізаються, а невідповідність схемі все одно дає `500`. Режим задає `RESPONSE_VALIDATION_CONTRACT`, вимкнути перевірку не можна. Детальніше — [Перевірка відповідей](/backend/response-validation).
6. **Однакова структура — менше контексту.** Кожна фіча бекенду складається з тих самих шарів route → controller → service → repository. Агенту не треба читати весь проєкт: достатньо відкрити сусідню фічу як зразок.
7. **Одна команда, щоб перевірити все.** [`init.sh`](https://github.com/Blazheiko/vibe-template/blob/main/init.sh) запускає install, typecheck, lint, test і build. Ті самі перевірки (плюс `format:check` і Playwright) виконує CI на кожен PR, тож «у мене працює» агента перевіряється так само, як код людини.
8. **Правила роботи записані для агента.** [`AGENTS.md`](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md) описує порядок старту сесії, Definition of Done і правила документації. `feature_list.json` фіксує, хто над якою фічею працює, а `progress.md` і `session-handoff.md` на гілці фічі переносять стан між сесіями. Агент починає нову сесію з файлів, а не з пам'яті попередньої розмови. Детальніше — [Процес роботи](/guide/workflow).
9. **Готовий скіл для нової фічі.** Скіл Claude Code [`backend-feature`](https://github.com/Blazheiko/vibe-template/blob/main/.claude/skills/backend-feature/SKILL.md) лежить у репозиторії (`.claude/skills/`) і проводить агента через усі шари бекенду: схеми в `shared`, таблицю й міграцію, repository, transformer, service, controller, контракт і маршрут, тест. Він спирається на туторіал [Як додати фічу](/backend/adding-a-feature) і оновлюється в тому ж PR, що змінює ці патерни.

::: warning Чого типи не гарантують
Перевірки ловлять помилки форми: неправильні типи, забуті місця використання, порушені шари. Вони не перевіряють, що бізнес-логіка правильна. Для цього потрібні тести на поведінку. Тест перевіряє лише ті випадки, які в ньому описано, тому на рев'ю людина перевіряє, чи описано потрібні випадки і чи не послаблено наявні.
:::

## Чому саме цей шаблон

- **Не треба писати фундамент.** Автентифікація, безпека, пошта, файли, push, адмінка й AI вже працюють. Це тисячі рядків коду, які ви не пишете й не дебажите.
- **Продуктивність.** uWebSockets.js — один з найшвидших HTTP/WebSocket-серверів для Node.js за [публічними бенчмарками](https://github.com/uNetworking/uWebSockets/tree/master/benchmarks) (власних вимірювань для шаблону немає). Real-time не потребує окремого сервісу.
- **Єдине джерело істини замість дубльованих типів.** Контракт API описано один раз arktype-схемою в пакеті `shared`: з неї бекенд перевіряє запит і відповідь під час виконання, а тип виводиться (`typeof Schema.infer`) і імпортується і бекендом, і фронтендом. Структуру БД описано один раз Drizzle-схемою: з неї генеруються міграції й виводяться типи рядків (`InferSelectModel`). Змінили схему — `pnpm typecheck` показує всі місця на сервері й клієнті, які треба оновити. Як це влаштовано — [Звідки беруться типи](/guide/how-backend-works#звідки-беруться-типи-єдине-джерело-істини).
- **Передбачувана структура.** Кожна фіча складається з однакових шарів. Знаючи одну, ви орієнтуєтесь у всіх. Правила шарів перевіряються тестом, тому архітектура не «розпливається» з часом.
- **Безпечні значення за замовчуванням.** Більшість захистів (CSP, security-заголовки, rate limiting, HttpOnly-cookie) увімкнені одразу, а сервер не стартує з частиною небезпечних налаштувань (перевірка `validateRuntimeConfig`). Виняток — CSRF: за замовчуванням він лише логує порушення, для продакшену треба увімкнути `CSRF_ENFORCE=true`.
- **PWA і push одразу.** Застосунок можна встановити на пристрій з меню, а сервер уміє надсилати Web Push навіть коли вкладку закрито. Для push треба лише VAPID-ключі в `.env`.
- **Готово до продакшену.** Логи Pino, Sentry, health-check `/ready`, graceful shutdown, Dockerfile з healthcheck, конфігурація через env. Як зібрати й запустити — [Деплой](/backend/deployment).
- **Тести з коробки.** Понад тисячу unit- та інтеграційних тестів на Vitest. Тести з PostgreSQL створюють для себе окрему тимчасову базу, а Playwright перевіряє фронтенд у браузері. Детальніше — [Тестування](/backend/testing).
- **Приклади юридичних сторінок.** Privacy Policy, Terms, Cookies Policy і AI Policy вже мають маршрути й сторінки у фронтенді. Це **приклад-заготовка**, а не готовий юридичний текст: замініть зміст на свій і погодьте з юристом перед запуском.

## Як це виглядає на практиці

Три приклади з коду шаблону, що показують, що дають ці переваги, коли ви змінюєте продукт.

### Змінили контракт — TypeScript показав, що зламалось

Список користувачів в адмінці описано однією схемою в `shared` ([admin-user-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/admin-user-controller.ts)). Тип виводиться з неї, а не пишеться окремо:

```ts
export const AdminUserListItemSchema = type({
    id: 'string',
    name: 'string', // перейменуємо на fullName
    email: 'string',
    registeredAt: 'string',
})
export type AdminUserListItem = typeof AdminUserListItemSchema.infer
```

Після перейменування `name` → `fullName` TypeScript показує обидві сторони:

```text
packages/backend typecheck: src/app/controllers/http/admin/admin-user-controller.ts(29,37):
  error TS2322: Type 'AdminUserListItem[]' is not assignable to type
  '{ id: string; fullName: string; email: string; registeredAt: string; }[]'.
src/views/admin/AdminUsersView.vue(165,37): error TS2339: Property 'name' does not exist on type
  '{ id: string; fullName: string; email: string; registeredAt: string; }'.
```

`pnpm typecheck` зупиняється на першому пакеті з помилкою, тому помилку фронтенду видно після виправлення бекенду або в `pnpm --filter frontend typecheck`.

Без спільного типу бекенд почав би віддавати нове поле, а таблиця в адмінці мовчки показувала б порожню колонку. Та сама схема описує відповідь маршруту `GET /api/admin/users` в [API Playground](/playground/), тож документація API теж не розійдеться з типом.

::: warning Обмеження
Захист типами працює лише там, де обидві сторони справді імпортують тип з `shared`. Перевірка відповідей за `ResponseSchema` ([аргумент 5](#чому-шаблон-підходить-для-агентної-розробки)) захищає сервер, але фронтенд від цього не захищений: якщо компонент описав власний тип замість імпорту з `shared`, розбіжність побачить лише користувач. Новий код варто писати так, як у прикладі вище: схема в `shared`, тип через `.infer`, і цей тип у сервісі, контролері й компоненті.
:::

### Один сервіс для HTTP і WebSocket

Чат підтримки працює через два транспорти: повідомлення йдуть по WebSocket ([ws/support-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/ws/support-controller.ts)), а історія чату завантажується по HTTP ([http/support/support-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/support/support-controller.ts)). Обидва контролери тонкі й викликають той самий `supportService`:

```ts
// WebSocket: нове повідомлення в чат
const admission = await supportService.admitChat(userId, payload.message)
if (Result.isError(admission)) return mapWsControllerError(context, admission.error)
void supportService.runChat(
    admission.value,
    userId,
    payload.message,
    userData.uuid,
    context.signal,
    payload.language,
    payload.clientMessageId,
)

// HTTP: історія чату
const result = await supportService.getChatHistory(userId, { before, limit })
```

Правила чату (ліміти, збереження історії, звернення до AI) живуть в одному місці. Якщо їх змінити, зміниться поведінка обох транспортів.

### Тест бізнес-логіки без бази даних

Сервіс отримує дані тільки через репозиторій, тому в тесті репозиторій легко підмінити. Фрагмент з [avatar-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/avatar-service.spec.ts):

```ts
const userRepositoryMock = { findById: vi.fn(), update: vi.fn() }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
}))

userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Alice', avatar: null })
const result = await avatarService.uploadAvatar(7n, file)
expect(Result.isOk(result)).toBe(true)
```

Тест перевіряє логіку завантаження аватара за мілісекунди, без PostgreSQL, Redis і S3.

## Що вже реалізовано

Нижче перелічено функціонал, яким можна користуватися одразу. Префікс API за замовчуванням — `/api` (`appConfig.pathPrefix`).

### Автентифікація та акаунт

| Можливість                    | Як це працює                                                                       | Детальніше                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Реєстрація по email           | `POST /auth/register/email`, лист з посиланням для підтвердження                   | [Автентифікація](/backend/auth#способи-входу)       |
| Підтвердження email           | `POST /auth/verify-email`, повторна відправка `resend-verification-email`          | [Пошта](/backend/mail)                              |
| Реєстрація і вхід по телефону | SMS-код: `register/phone/start` → `confirm` → `complete-profile`                   | [Автентифікація](/backend/auth#способи-входу)       |
| Вхід через соцмережі (OAuth)  | Google, GitHub, GitLab, Facebook: `auth/oauth/:provider/redirect` і `/callback`    | [Автентифікація](/backend/auth#способи-входу)       |
| Логін / логаут                | `POST /auth/login`, `/logout`, `/logout-all` (вийти на всіх пристроях)             | [Автентифікація](/backend/auth)                     |
| Зміна і скидання пароля       | `change-password`, `forgot-password` → лист → `reset-password`; скидання через SMS | [Автентифікація](/backend/auth)                     |
| Прив'язка телефону / email    | `link-phone/start`, `link-phone/confirm`, `link-email/start`                       | [Автентифікація](/backend/auth)                     |
| Аватар користувача            | `POST /avatar/upload` (S3/MinIO), `DELETE /avatar`                                 | [Сховище файлів](/backend/storage)                  |
| Ролі                          | Звичайний користувач і адміністратор, guard-и `auth_guard` і `admin_guard`         | [Ролі та можливості](/reference/roles-capabilities) |

### Безпека

| Можливість                | Що дає                                                                          | Детальніше                                                   |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Сесії в Redis             | HttpOnly-cookie з HMAC-підписом, ротація токена, миттєве відкликання сесії      | [Сесії](/backend/auth#сесіі)                                 |
| CSRF-захист               | Токен для всіх запитів, що змінюють дані                                        | [CSRF](/backend/security#csrf)                               |
| CORS                      | Whitelist дозволених доменів                                                    | [CORS](/backend/security#cors)                               |
| CSP та security-заголовки | Content-Security-Policy, `X-Frame-Options` та інші заголовки на кожну відповідь | [Заголовки](/backend/security#заголовки-безпеки-та-csp)      |
| Rate limiting             | Глобальні та помаршрутні ліміти, в пам'яті або спільні через Redis              | [Ліміти](/backend/security#обмеження-частоти-запитів)        |
| Захист від перебору       | Throttling спроб входу, OTP-кодів і скидання пароля                             | [Політика входу](/backend/security#політика-входу)           |
| Trust proxy               | Коректний IP клієнта за nginx / балансувальником                                | [Trust proxy](/backend/security#trust-proxy-і-визначення-ip) |
| Валідація вхідних даних   | Кожен маршрут описує схему arktype; некоректний запит не дійде до вашого коду   | [Валідація](/backend/validation)                             |

### Real-time (WebSocket)

- Одне WebSocket-з'єднання на клієнта, авторизоване коротким токеном (`GET /main/update-ws-token`).
- Власний протокол повідомлень і диспетчер WS-маршрутів, які описуються так само, як HTTP-маршрути.
- Відстеження, хто онлайн, та історія онлайн-активності (для адмінки).
- Розсилка подій від сервера конкретному користувачу або каналу (`broadcast-service`).
- Heartbeat і таймаути, щоб «мертві» з'єднання закривались самі.

Детальніше: [WebSocket](/backend/websocket).

### Сповіщення та пошта

- **Транзакційні листи** через SMTP (nodemailer): підтвердження email, скидання пароля. Є скрипт `send-test-email` для перевірки налаштувань.
- **Web Push** (VAPID): підписка, оновлення, деактивація, тестова відправка, журнал доставок і статистика по кожній підписці (`/push-subscriptions/*`).

Детальніше: [Пошта](/backend/mail) і [Web Push сповіщення](/backend/web-push-notification).

### Файли

- Завантаження в S3-сумісне сховище (AWS S3, MinIO та ін.), presigned-посилання.
- Готовий приклад використання — аватари та скриншоти статей бази знань.

Детальніше: [Сховище файлів (S3)](/backend/storage).

### AI

- **Чат підтримки (Support AI):** відповідає на питання користувача на основі бази знань. Пошук релевантних статей через embeddings у PostgreSQL (pgvector), потокова відповідь через WebSocket, історія чату.
- **База знань:** CRUD статей, скриншоти, переіндексація однієї статті або всіх, початкове наповнення.
- **Промпти в БД:** системні промпти редагуються з адмінки без деплою, їх можна протестувати перед збереженням.
- **Облік токенів:** статистика використання AI.
- **Кілька провайдерів:** OpenAI, xAI (Grok), Mistral. Провайдер обирається змінною `AI_TEXT_DRIVER` або назвою моделі в промпті.

Детальніше: [AI-інтеграції](/backend/ai).

### Адмін-панель

- Список користувачів.
- Хто зараз онлайн (оновлюється в реальному часі через WebSocket) та історія онлайну.
- Керування базою знань і AI-промптами, статистика використання AI.

Доступ лише для ролі адміністратора — [Ролі та можливості](/reference/roles-capabilities).

### Фронтенд

- Vue 3 + Pinia + vue-router, guard-и маршрутів для авторизованих і адмін-сторінок.
- Готові сторінки: логін/реєстрація, підтвердження email, скидання пароля, акаунт, чат підтримки, адмінка, юридичні сторінки (Privacy, Terms, Cookies, AI Policy).
- **3 мови** інтерфейсу (vue-i18n): англійська, українська й польська ([`SHIPPED_LOCALE_CODES`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/enums/languages.ts)); 18 кодів `APP_LOCALE_CODES` AI-підтримка використовує для розпізнавання мови повідомлень.
- **PWA:** встановлення на пристрій, офлайн-режим, push-сповіщення.
- HTTP-клієнт, який сам додає CSRF-токен і обробляє сесію; WebSocket-клієнт з перепідключенням.
- Unit-тести (Vitest) та e2e (Playwright).

Детальніше: [Фронтенд](/frontend/).

### Інфраструктура та якість

| Можливість      | Що є                                                                                     | Детальніше                                 |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| База даних      | PostgreSQL + Drizzle ORM, міграції, seed, скрипт створення БД                            | [База даних](/backend/database)            |
| Конфігурація    | Усе через змінні оточення, перевірка конфігурації при старті                             | [Конфігурація](/backend/configuration)     |
| Логи та помилки | Pino (структуровані логи), Sentry на бекенді й фронтенді                                 | [Observability](/backend/observability)    |
| Health-check    | `GET /ping` (процес живий), `GET /ready` (БД і Redis доступні)                           | [Деплой](/backend/deployment)              |
| Кешування       | Роздача статики з ETag і `Cache-Control`, процесні кеші                                  | [Кешування та ETag](/backend/caching-etag) |
| Тести           | Vitest для бекенду, тест, що стежить за правилами шарів архітектури                      | [Тестування](/backend/testing)             |
| API Playground  | Окремий dev-застосунок для ручного виклику HTTP і WS-маршрутів без Postman               | [API Playground](/playground/)             |
| Деплой          | Збірка в `dist`, graceful shutdown, робота за проксі, роздача фронтенду з того ж процесу | [Деплой](/backend/deployment)              |

## Автор

Шаблон розробив **Олександр Блажейко** ([GitHub](https://github.com/Blazheiko), [blazheiko@gmail.com](mailto:blazheiko@gmail.com)). Детальніше — на сторінці [Про автора](/reference/author).

## З чого почати

1. [Вступ](/guide/introduction) — для чого шаблон і кому він підходить.
2. [Швидкий старт](/guide/getting-started) — встановлення та перший запуск.
3. [Як влаштований бекенд](/guide/how-backend-works) — пояснення для початківців.
4. [Структура проєкту](/guide/project-structure) — де що лежить.
5. [Як додати фічу](/backend/adding-a-feature) — покроковий туторіал: від таблиці в БД до маршруту.
