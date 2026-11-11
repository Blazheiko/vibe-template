# ADR 0005: контракти маршрутів у `shared` — один опис для бекенду й фронтенду

- **Статус:** прийнято 2026-11-11 (рішення власника Д6 плану code review 2026-11-10); пілот — feat-168.
- **Дата запису:** 2026-11-11.
- **Джерело:** [`docs/plan/code-review-2026-11-10-report.md`](../plan/code-review-2026-11-10-report.md), розділ «Рекомендація: автоматична перевірка відповідності API»; план — [`code-review-2026-11-10-plan.md`](../plan/code-review-2026-11-10-plan.md), фічі C0–C6.

## Контекст

Бекенд зв'язаний зі схемами: `defineRoute` бере `validator` і `ResponseSchema` із `shared`, відповідь перевіряється під час виконання. Фронтенд бере з `shared` лише типи, а шлях, метод і тип відповіді з'єднує вручну:

```ts
baseApi.http<PushSubscriptionResponse[]>('GET', apiPath('push-subscriptions'))
```

Ніщо не перевіряє, що цей тип належить цьому маршруту. Наслідок уже був: локальний `PushSubscriptionResponse` у `frontend/src/utils/api.ts` не відповідав реальній відповіді, і стор працював лише через приведення до `Record<string, unknown>`.

Перша редакція рекомендації пропонувала передавати фронтенду об'єкт контракту разом зі схемами. Це суперечило вимозі не тягнути схеми в бандл: runtime-імпорт такого об'єкта приводить у збірку `shared/schemas`, `shared/responses` і ArkType.

## Рішення

### 1. Межа пакетів: у браузері — метод, шлях і типи

Контракт під час виконання — це `{ method, path }`. Типи тіла, query й відповіді — параметри типу; схеми, з яких вони беруться, імпортуються через `import type`, тож у згенерованому JS контракту немає жодного імпорту схеми.

```ts
// packages/shared/src/contracts/push-subscriptions.ts
import type { CreateSubscriptionInputSchema } from '../schemas/push-subscription/create-subscription.js'
import type { CreateSubscriptionResponse } from '../responses/push-subscription-controller.js'
import { contract } from './core.js'

export const pushSubscriptionContracts = {
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
    remove: contract<undefined, undefined, DeleteSubscriptionResponse>()(
        'delete',
        '/push-subscriptions/:subscriptionId',
    ),
}
```

Сервер прив'язує схеми до контракту сам, у таблиці маршрутів (рішення 4). Контракти — окремий subpath `shared/contracts`.

**Як це перевіряється.** На графі модулів production-збірки фронтенду, а не за розміром бандла чи пошуком назв у мінімізованому коді:

```sh
pnpm --filter shared build
pnpm --filter frontend check:bundle-graph
# check-bundle-graph: 492 modules, no schema and no validator library.
```

[`packages/frontend/scripts/check-bundle-graph.mjs`](../../packages/frontend/scripts/check-bundle-graph.mjs) збирає застосунок через Vite без запису на диск, бере список модулів, які Rollup справді включив (`getModuleIds`), і падає, якщо серед них є `@arktype/*`, `arktype`, `shared/dist/schemas/` або `shared/dist/responses/`. Негативний контроль (2026-11-11): один рядок `import { LoginInputSchema } from 'shared/schemas'` у `utils/api.ts` — перевірка завершується з кодом 1 і називає модулі ArkType. Команда входить у пілот (C1.7) і в CI.

### 2. Вхідний і вихідний тип схеми

Схема може розбирати й доповнювати дані (`string.integer.parse`, `.default()`), тому те, що надсилає клієнт, і те, що отримує обробник, — різні типи.

- **Тіло.** Тип контракту — `typeof Schema.inferIn` (вхід схеми). Обробник отримує `Schema.infer` (вихід), як і раніше.
- **Query.** Вхід query-схеми — рядки (`limit?: string`), а клієнтові зручно передати число. Тому query контракту описано явним типом того, що клієнт може надіслати (наявні `*QueryInput` у `shared/schemas/query`: число або числовий рядок, дата рядком). Серіалізація перетворює значення на рядки; сервер перевіряє, що **ключі** схеми й контракту збігаються.
- **Відповідь.** Тип контракту — тип відповіді з `shared/responses` (`typeof Schema.infer`, для частини маршрутів з `WithCanonicalError`). Порівнюються лише успішні гілки: гілка помилки в усіх маршрутів спільна, а клієнтський тип навмисно звужує її `details`.

### 3. Форма виклику: поверх наявного транспорту

```ts
// packages/frontend/src/utils/api-client.ts
callApi(pushSubscriptionContracts.remove, { params: { subscriptionId } })
callApi(adminContracts.users, { query: { limit: 100, cursor } })
callApi(authContracts.login, { body }, { csrfRecovery: 'public' })
callApi(pushSubscriptionContracts.list)
```

- Перший аргумент — контракт; другий — `{ params, query, body }` лише з тими частинами, які контракт має (обов'язковий, якщо обов'язкова хоч одна); третій — опції транспорту (`HttpOptions`: `signal`, `csrfRecovery`, `sessionAfter`), які передаються без змін.
- `callApi` викликає `baseApi.http` з [`base-api.ts`](../../packages/frontend/src/utils/base-api.ts). CSRF-токен, шлюз сесії, перевірка зміни акаунта й один повтор після `token_mismatch` лишаються там, де були. Клієнт їх не дублює і не обходить; його тести викликають саме `callApi` на справжньому транспорті, бо тести транспорту лишилися б зеленими, якби обгортка загубила опцію.
- **Multipart поза контрактом.** Тіло контракту — JSON. Завантаження файлів (`baseApi.upload`, `FormData`) лишаються прямими викликами і входять у список винятків правила ESLint, доки для них не буде окремого рішення.

### 4. Серверні політики — поза контрактом

```ts
// packages/backend/src/app/routes/http-routes.ts
defineContractRoute({
    contract: pushSubscriptionContracts.create,
    validator: CreateSubscriptionInputSchema,
    ResponseSchema: ResponseSchemas.CreateSubscriptionResponseSchema,
    handler: PushSubscriptionController.createSubscription.bind(PushSubscriptionController),
    middlewares: ['auth_guard'],
})
```

- `defineContractRoute` — окрема функція поруч із `defineRoute` (перевантаження `defineRoute` ламало виведення типів у наявному коді). Метод і шлях беруться з контракту; `url` і `method` у маршруті не повторюються.
- Схеми вказуються тут і звіряються з типами контракту компілятором: вхід схеми тіла дорівнює типу тіла; ключі query-схеми дорівнюють ключам query контракту; успішні гілки схеми відповіді дорівнюють типу відповіді. Схема іншого маршруту, пропущена схема або зайва схема — помилка `pnpm typecheck` з назвою причини (`__contractMismatch`).
- Middleware, guards, ліміти запитів, `allowedContentTypes`, `maxBodySize`, групи маршрутів лишаються конфігурацією бекенду. Контракт про них нічого не каже, і клієнт про них не знає.
- Маршрут лишається у своїй групі (вона дає middleware і ліміти). Роутер на старті перевіряє, що шлях контракту починається з префікса групи: контракт `/admin/users` у групі `auth` зупиняє запуск.

### 5. Побудова URL

Крім типів потрібне фактичне кодування, тому в `shared/contracts` є `buildPath`, `buildQuery`, `buildUrl`:

- кожен `:name` замінюється на `encodeURIComponent(value)`: значення зі `/` чи `?` лишається одним сегментом; відсутнє значення — виняток (помилка програміста, а не запит на інший маршрут);
- query: `undefined`, `null` і порожній рядок пропускаються, масив повторює ключ, порядок ключів зберігається, значення кодуються;
- імена параметрів шляху виводяться з рядка шляху типом (`PathParams<'/x/:id'>` → `{ id: string }`), тож `params` з іншою назвою не компілюється.

## Перевірка прототипом (2026-11-11)

Три маршрути пілота: група `push-subscriptions` (10 маршрутів, є тіло й параметри шляху), `GET /admin/users` (query з розбором і значеннями за замовчуванням), `POST /auth/login` (публічний маршрут з `csrfRecovery: 'public'`).

- `pnpm typecheck` чистий; бекенд після переведення 12 маршрутів: unit 2612, PG 288 — без змін у поведінці.
- Перевірка звірки знайшла справжню розбіжність: `AdminUserListResponse` звужує гілку помилки (`WithCanonicalError`), тому порівняння відповіді зведено до успішних гілок (рішення 2).
- Негативні перевірки типів (`@ts-expect-error`, компілюються разом зі специфікаціями):
    - клієнт: пропущене тіло; зайве поле; поле не того типу; пропущений або інакше названий параметр шляху; тіло для маршруту без тіла; невідомий ключ query; поле, якого немає у відповіді;
    - сервер: схема тіла іншого маршруту; пропущена схема тіла або query; схема тіла для маршруту без тіла; схема відповіді іншого маршруту; інші ключі query; обробник, що повертає не той тип.
- Клієнт на справжньому транспорті (12 тестів): `signal` доходить до `fetch` і скасування завершує виклик; `csrfRecovery: 'public'` і типове `'protected'`; один повтор після `token_mismatch`; зміна акаунта — без повтору, перезавантаження; `sessionAfter: 'anonymous'`.

## Розглянуті альтернативи

- **Об'єкт контракту зі схемами у фронтенді.** Відхилено: тягне ArkType і всі схеми в бандл; видалення збирачем не гарантоване.
- **OpenAPI + генерація клієнта.** Другий формат поруч з ArkType і крок генерації, який треба тримати свіжим. Має сенс лише за появи зовнішніх споживачів API.
- **Перевірка відповідей на фронтенді під час виконання.** Дублює те, що бекенд уже робить, і потребує схем у бандлі. Максимум — в e2e.
- **Лише e2e-тести.** Ловлять розбіжність тільки на покритих сценаріях і пізно.
- **Перевантаження `defineRoute({ contract })`.** Відхилено на прототипі: `Parameters<typeof defineRoute>` у наявних тестах почав виводитися з іншої сигнатури. Окрема функція простіша в типах, і маршрути з контрактом легко знайти.

## Цільовий стан (рішення C1.R, 2026-11-11)

Власник прийняв пілот і перенесення решти маршрутів (C4) з такою кінцевою точкою:

1. **Контракт — єдиний спосіб оголосити маршрут.** Коли старих маршрутів не лишиться (C5b),
   `defineRoute` без контракту видаляється, а `defineContractRoute` стає `defineRoute`.
   Співіснування двох функцій — тимчасовий стан міграції.
2. **Схеми — в одному реєстрі за контрактом.** Замість того щоб вказувати `validator`,
   `queryValidator` і `ResponseSchema` поруч із контрактом у таблиці маршрутів, сервер бере їх із
   реєстру `контракт → схеми` (C7, до перенесення груп, щоб не переписувати маршрути двічі).
   Звірка зі типами контракту переходить на записи реєстру. Схеми, як і раніше, лишаються поза
   бандлом фронтенду.
3. **Multipart і не-JSON — у контракті.** Контракт описує тіло multipart і відповіді-редірект та
   файл (C8); виняток «multipart поза контрактом» з рішення 3 знімається, і поза клієнтом не
   лишається прямих викликів транспорту.

Порядок фіч і розбиття на групи — у плані, розділ «C7, C4, C8, C5b, C6».

## Наслідки

- Розбіжність між клієнтом і сервером у методі, шляху, тілі, параметрах чи формі відповіді стає помилкою `pnpm typecheck`.
- Типи гарантують форму даних, а не поведінку: логічні дефекти (наприклад, загублений `?redirect=`) вони не ловлять.
- Нова фіча бекенду додає контракт у `shared/contracts`; сторінки `documentation/backend/` про маршрути й додавання фічі оновлюються в пілоті.
- До завершення міграції (C4) співіснують `defineRoute` і `defineContractRoute`, `baseApi.http` і `callApi`. Правило ESLint забороняє нові прямі виклики `baseApi.http`; наявні — у списку винятків, який скорочується з кожною групою.
- WebSocket (запити, відповіді, broadcast-події, кореляція) — окремий дизайн (C6).
