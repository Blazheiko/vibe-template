# Маршрутизація

Маршрути бекенду описуються декларативно у двох файлах: HTTP — у [`src/app/routes/http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts), WebSocket — у [`src/app/routes/ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts). Під час старту роутер ([`src/vendor/start/router.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)) розгортає групи, склеює префікси та списки middleware і реєструє маршрути в uWebSockets.js. Загальний шлях запиту описано на сторінці [Життєвий цикл запиту](/backend/request-lifecycle), ланцюжок перевірок перед обробником — на сторінці [Middleware](/backend/middlewares).

## Маршрут — єдине джерело істини

Усе, що бекенд знає про ендпоінт, записано у трьох місцях, які звіряє компілятор: **контракт** у `shared/contracts` (метод, шлях, типи тіла, query й відповіді), **запис реєстру схем** у бекенді (ArkType-схеми тіла, query й відповіді цього контракту) і **об'єкт маршруту** в `http-routes.ts` (обробник, middleware, ліміти). Окремого файлу з правами доступу чи окремого опису API немає: з цих трьох місць усе виводиться автоматично.

| Що                             | Звідки береться                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| URL і HTTP-метод               | `method` і `path` контракту + `API_PATH_PREFIX`; префікс групи має бути початком `path`                                       |
| Хто має доступ                 | `middlewares` маршруту і всіх його груп                                                                                       |
| Перевірка тіла і query         | схеми `body` і `query` запису реєстру, `queryAllowExtra`, `queryArrays` маршруту — під час виконання                          |
| Типи `payload` і `query`       | TypeScript виводить їх з тих самих схем у сигнатуру `handler` — під час компіляції                                            |
| Параметри шляху (`:id`)        | роутер читає їх з `path` контракту                                                                                            |
| Які `Content-Type` приймаються | `allowedContentTypes` (за замовчуванням лише JSON; для multipart-контракту — лише `multipart`)                                |
| Ліміт частоти запитів          | `rateLimit` маршруту або групи                                                                                                |
| Документація API               | `GET /<prefix>/doc/routes` і [API Playground](/playground/) серіалізують ті самі об'єкти: URL, метод, middleware, схеми, опис |

Тому правило просте: **щоб змінити поведінку ендпоінту, змініть його маршрут, контракт або запис реєстру.** Додали `auth_guard` — маршрут закрито і це одразу видно в playground. Змінили схему тіла в записі реєстру — змінилися і перевірка на сервері, і тип `payload` у контролері, і опис у `/doc/routes`, а якщо вхід схеми розійшовся з типом тіла контракту, `pnpm typecheck` назве це місце. Розбіжності між «що написано в документації» і «що робить сервер» тут неможливі, бо документацію серіалізовано з тих самих об'єктів.

Схеми самі живуть у пакеті `shared`, тож вони — єдине джерело істини для форми даних між фронтендом і бекендом, а маршрут — для того, як контракт підключено до сервера. Детальніше — [Звідки беруться типи](/guide/how-backend-works#звідки-беруться-типи-єдине-джерело-істини).

## HTTP-маршрути: `defineRoute`

Кожен HTTP-маршрут застосунку оголошено через **контракт** ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md)). Інших способів оголосити маршрут у таблиці немає. Контракт — це метод, шлях під API-префіксом і три типи (тіло, query, відповідь); під час виконання він лише `{ method, path }` (і `kind` для не-JSON), тож фронтенд імпортує його без схем і без ArkType.

Новий маршрут складається з чотирьох частин:

```ts
// 1. packages/shared/src/contracts/push-subscriptions.ts — контракт
export const pushSubscriptionContracts = {
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
    // …
} as const

// 2. packages/backend/src/app/routes/contract-schemas/push-subscriptions.ts — схеми
export const pushSubscriptionSchemas = contractSchemas(pushSubscriptionContracts, {
    create: {
        body: CreateSubscriptionInputSchema,
        response: ResponseSchemas.CreateSubscriptionResponseSchema,
    },
    // …по запису на кожен контракт групи
})

// 3. packages/backend/src/app/routes/http-routes.ts — маршрут
import { defineRoute } from '#app/routes/contract-schemas/index.js'

defineRoute({
    contract: pushSubscriptionContracts.create,
    handler: PushSubscriptionController.createSubscription.bind(PushSubscriptionController),
    middlewares: ['auth_guard'],
})

// 4. packages/frontend/src/utils/api.ts — виклик
callApi(pushSubscriptionContracts.create, { body })
```

- **Контракт** оголошують у [`packages/shared/src/contracts/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/core.ts), по файлу на групу: `contract<Тіло, Query, Відповідь>()(метод, шлях)`. Шлях повний, від API-префікса (`/push-subscriptions/:subscriptionId`), а не відносно групи. Типи схем імпортуються через `import type`, тому в JS контракту немає жодної схеми. Група експортується з [`contracts/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/index.ts) (subpath `shared/contracts`).
- **Схеми** маршрутів живуть в одному **реєстрі** [`app/routes/contract-schemas/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts), по файлу на групу контрактів, а [`index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts) зводить їх у `contractSchemaRegistry` за ключем `<метод> <шлях>` контракту через [`mergeContractSchemas`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts). Два контракти з тим самим ключем (в одній групі чи в різних) зупиняють імпорт реєстру помилкою `Route contract <ключ> is declared twice`, тож ні сервер, ні тести з дублікатом не стартують; `route-contracts.spec.ts` звіряє, що кожен контракт `shared/contracts` має свій ключ і запис. [`contractSchemas(group, { name: { body?, query?, response } })`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) вимагає запис для кожного контракту групи й звіряє його з типами контракту: вхід схеми `body` дорівнює типу тіла, тип query контракту — [`QueryInputOf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/query/types.ts) схеми `query` (ті самі ключі й необов'язковість, значення так, як їх надсилає клієнт: розібране число — числом або рядком, дата — рядком), успішні гілки схеми `response` — типу відповіді. Схема тіла іншого маршруту, пропущена чи зайва схема, інша схема відповіді, пропущений контракт — помилка `pnpm typecheck` з причиною в `__contractMismatch`. Реєстр лежить у бекенді, тож схеми не потрапляють у бандл фронтенду.
- **`defineRoute`** експортує [`app/routes/contract-schemas/index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts) (його будує `contractRouteDefiner(contractSchemaRegistry)`). Він бере `method` і `url` з контракту, а `validator`, `queryValidator` і `ResponseSchema` — із запису реєстру: схему тіла загортає в `defaultValidator`, до схеми query застосовує політику зайвих ключів. У маршруті ці поля не пишуться. Тип `payload` і `query` обробника — вихід (`infer`) схем запису, а `httpData.params` — параметри шляху контракту (`PathParams`). Метод контролера, оголошений окремо, бере їх з контракту: `HttpContext<Payload, Query, ParamsOf<typeof contracts.get>>` ([`ParamsOf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts)); перейменований у контракті сегмент `:name` — помилка компіляції в контролері. Контракт без запису — помилка компіляції, а на старті — `Route contract … has no entry in the schema registry`. Тип результату — `RouteItem` з [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts).
- Middleware, ліміти, `allowedContentTypes`, `maxBodySize` і група маршруту лишаються конфігурацією бекенду: контракт про них нічого не каже. Маршрут стоїть у групі, префікс якої є початком шляху контракту; інакше сервер не стартує (`Route contract /… is declared in the route group "/…"`).
- На фронтенді [`callApi(contract, { params, query, body }, options)`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) викликає маршрут контракту поверх наявного транспорту (CSRF, шлюз сесії, `options` — `signal`, `csrfRecovery`, `sessionAfter`). Неправильне тіло, параметр шляху чи ключ query, а також пропущений query з обов'язковим ключем — помилка компіляції. Правила ESLint у [`packages/frontend/eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/eslint.config.ts) не дають обійти клієнт: default-імпорт `base-api` під будь-яким ім'ям, з розширенням чи без (`./base-api.ts`), і `import()` модуля дозволено лише `utils/api-client.ts`, `fetch` (також `window.`/`globalThis.`/`self.fetch`) — лише транспорту `base-api.ts` і service worker'у. Сам транспорт викликає `main/init` напряму (на це оновлення сесії чекає `callApi`), але шлях і метод бере з `mainContracts.init`. Правила перевіряє [`api-bypass-lint.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/__tests__/api-bypass-lint.spec.ts).
- `pnpm check:bundle-graph` (частина `make check`) перевіряє на графі модулів production-збірки, що у бандл фронтенду не потрапили схеми й ArkType.

### Multipart і маршрути-переходи

- `multipartContract<Поля, 'імʼя-файлу', Відповідь>()('post', шлях)` — тіло з текстових полів і файлів. Запис реєстру описує схему **полів**, файли читаються з `httpData.files`. `defineRoute` сам ставить `allowedContentTypes: ['multipart']`, `maxBodySize` лишається налаштуванням маршруту. На фронтенді `callApi(avatarContracts.upload, { body: { fields: {}, files: { avatar: blob } } })` збирає `FormData` і надсилає через `baseApi.upload` з тим самим CSRF-токеном і шлюзом сесії. Приклад з `http-routes.ts`:

```ts
defineRoute({
    contract: avatarContracts.upload,
    handler: AvatarController.uploadAvatar.bind(AvatarController),
    maxBodySize: multipartBodyLimit(AVATAR_MAX_FILE_BYTES),
    description: 'Upload user avatar',
}),
```

- `navigationContract<Query, Відповідь>()(шлях)` — GET, який браузер не завантажує через `fetch`, а відкриває: редірект OAuth (`/auth/oauth/:provider/redirect`, `callback`) чи файл (`/support/screenshot/:articleId` для `<img>`). `callApi` такий контракт не приймає; [`contractUrl(contract, { params, query })`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) будує його адресу.

### Маршрут без контракту: лише в тестах

Хелпер, що будує маршрут зі схем без контракту, називається `defineRawRoute` і лежить у [`src/app/routing/define-raw-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-raw-route.ts). Він приймає `url`, `method`, `validator`, `queryValidator` і `ResponseSchema` напряму і потрібен лише тестам HTTP-машинерії (методи з тілом, ліміти, валідація, кеш у `src/vendor/start/*.spec.ts`), які будують власні маршрути.

- Правило ESLint `no-restricted-imports` у кореневому [`eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/eslint.config.ts) забороняє імпорт `#app/routing/define-raw-route.js` у `packages/backend/src` поза `*.spec.ts`/`*.test.ts`.
- Тест [`route-contracts.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-contracts.spec.ts) проходить усю таблицю `http-routes.ts` і падає, якщо маршрут не має контракту, запису в реєстрі, схеми відповіді або, для `post`/`put`/`patch`, схеми тіла; а також якщо в реєстрі є запис без маршруту.

## Усі поля маршруту

Поля, які приймає `defineRoute`. Тип — `RouteConfig` у [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts) без полів, що їх дає контракт і реєстр.

### Обов'язкові

| Поле       | Тип                                        | Що робить                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract` | контракт з `shared/contracts`              | Дає метод і шлях маршруту та ключ запису в реєстрі схем. Сегменти `:name` шляху стають параметрами: роутер збирає їх у `parametersKey`, а значення приходять у `httpData.params` (`/:provider/callback` → `params.provider`). |
| `handler`  | `(context) => Payload \| Promise<Payload>` | Метод контролера, прив'язаний через `.bind(Controller)`. Тип `context.httpData.payload` виводиться зі схеми `body` запису реєстру, тип `context.httpData.query` — зі схеми `query`. Повернене значення стає тілом відповіді.  |

### Що дає контракт і реєстр

Ці поля є в `RouteConfig`, але в `defineRoute` їх **не пишуть**: `defineRoute` заповнює їх сам, а TypeScript не прийме їх у маршруті.

| Поле             | Звідки                    | Що робить                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`            | `path` контракту          | Повний шлях під API-префіксом; префікс групи має бути його початком. Скісні риски на краях нормалізуються.                                                                                                                                                                                                                                                                                                                                  |
| `method`         | `method` контракту        | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'`. `delete` всередині перетворюється на `del` (так його називає uWebSockets.js). Чи читається тіло, залежить від методу — див. [нижче](#методи-і-тіло-запиту).                                                                                                                                                                                                                              |
| `validator`      | `body` запису реєстру     | Схема тіла з `shared/schemas`, загорнута в `defaultValidator`. Лише для `post`/`put`/`patch`: контракти `get`/`delete` оголошують тіло `undefined`, а маршрут `get`/`delete` зі схемою тіла зупиняє старт. Невалідне тіло → `422`.                                                                                                                                                                                                          |
| `queryValidator` | `query` запису реєстру    | Схема query-рядка з політикою зайвих ключів (див. `queryAllowExtra`). Якщо в контракту немає query, `httpData.query === null`, і читати будь-яке поле — помилка TypeScript. Query перевіряється до читання тіла.                                                                                                                                                                                                                            |
| `ResponseSchema` | `response` запису реєстру | Схема відповіді з `shared/responses`. Потрапляє в `/doc/routes` (`outputSchema`) і в playground, а під час виконання вона працює як allow-list: невідповідність — `500`, зайві поля — `500` у `strict` і вирізаються в `log` (`RESPONSE_VALIDATION_CONTRACT`, див. [Перевірка відповідей](/backend/response-validation)). Тип результату хендлера TypeScript звіряє з цією схемою — див. [Тип відповіді хендлера](#тип-відповіді-хендлера). |
| `contractPath`   | `path` контракту          | Службове: за ним роутер перевіряє префікс групи, а `route-contracts.spec.ts` — наявність запису в реєстрі.                                                                                                                                                                                                                                                                                                                                  |

### Запит

| Поле                  | Тип                 | За замовчуванням | Що робить                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryAllowExtra`     | `boolean`           | `false`          | `false` — суворо: незадекларований ключ → `422` (`onUndeclaredKey('reject')`). `true` — зайві ключі пропускаються, але **видаляються** і до контролера не доходять. Потрібно, коли query формує стороння система (OAuth-callback).                                                                                                                   |
| `queryArrays`         | `readonly string[]` | `[]`             | Ключі, які можуть повторюватися (`?tag=a&tag=b`). Вони збираються в `string[]` через `getAll`. Будь-який інший ключ, що трапився двічі, → `422`.                                                                                                                                                                                                     |
| `allowedContentTypes` | `BodyKind[]`        | `['json']`       | Які типи тіла приймає маршрут: `json`, `multipart`, `urlencoded`, `text`, `octet`, `other`. Інший `Content-Type` → `415`. Від типу залежить і ліміт розміру тіла (`MAX_JSON_BODY_SIZE`, `MAX_MULTIPART_BODY_SIZE` тощо, див. [Життєвий цикл запиту](/backend/request-lifecycle)). Для multipart-контракту `defineRoute` ставить `['multipart']` сам. |
| `maxBodySize`         | `number`            | ліміт типу тіла  | Власний ліміт розміру тіла маршруту в байтах. Завантаження аватара і скриншотів бази знань задають його через `multipartBodyLimit(...)` з [`upload-limits.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/upload-limits.ts).                                                                      |

### Доступ і обмеження

| Поле          | Тип                                         | Що робить                                                                                                                                                                                    |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `middlewares` | `string[]`                                  | Імена middleware з `kernel.ts`, які виконуються перед handler. Додаються **після** middleware груп. Невідоме ім'я — помилка `No middleware <name>`. Див. [Middleware](/backend/middlewares). |
| `rateLimit`   | `{ windowMs: number, maxRequests: number }` | Ліміт запитів з одного IP на цей маршрут за вікно `windowMs` мс. Перевищення → `429`. Якщо не задано, діє `rateLimit` найближчої групи. Перевіряється до читання тіла.                       |

### Документація

| Поле          | Тип      | Що робить                                     |
| ------------- | -------- | --------------------------------------------- |
| `description` | `string` | Короткий опис для `/doc/routes` і playground. |

### Службові поля

Ці поля є в типі `RouteConfig`, але **вручну їх не задають**:

| Поле             | Хто заповнює                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `parametersKey`  | роутер — список імен `:param` зі шляху                                              |
| `groupRateLimit` | роутер — ліміт групи, успадкований маршрутом                                        |
| `requestBody`    | ніхто: застаріле поле старого формату опису запиту, роутер і сервер його не читають |

## Тип відповіді хендлера

[`defineRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) і [`defineWsRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) вимагають, щоб хендлер повертав **вхідний** тип схеми відповіді (`inferIn`) або `Promise` від нього ([route-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/route-response.ts)). Для HTTP-маршруту це схема `response` запису реєстру, для WS — `ResponseSchema` маршруту. Це те саме значення, яке [перевірка відповідей](/backend/response-validation) подає у схему під час виконання. Розбіжність — помилка `tsc` на рядку `handler:` маршруту, на всіх маршрутах, а не лише на викликаних, і також для відповідей без перевірки під час виконання (3xx, 204, 205).

Без схеми відповіді (можливо лише у WS-маршруті або в `defineRawRoute` у тестах) хендлер повертає будь-який `Payload`.

Межі:

- **Анотацію результату контролера лишаємо** (`Promise<XxxResponse>` або `as const`). Без неї `return { status: 'success' }` виводиться як `{ status: string }` і перевірку не проходить. Це стосується й інлайн-хендлера прямо в `defineRoute`: TypeScript розширює літерал, коли контекстний тип узагальнений.
- Схема має бути точного типу `Type`. Для `Type | undefined` (наприклад, з умовного виразу) перевірки немає.
- Зайві поля TypeScript дозволяє (структурна типізація). Їх відсікає перевірка під час виконання: `500` у `strict`, вирізання в `log` ([Перевірка відповідей](/backend/response-validation)).
- Схема, вхід якої не є `Payload` (наприклад, масив верхнього рівня), не приймає жодного результату.
- Схеми редиректів (`{ status: 'redirect' }`, OAuth `redirect`/`callback`) перевіряє лише TypeScript: під час виконання 3xx не перевіряються.

Так виглядає помилка, якщо тип контролера ширший за схему (скорочено):

```text
src/app/routes/http-routes.ts(290,17): error TS2322: Type '(context: HttpContext<...>) =>
  Promise<{ status: string; message: string; sent?: number; failed?: number; }>' is not
  assignable to type 'TypedHandler<HttpContext<...>, { status: "error"; code: ...; } | { ...; }>'.
  ...
          Types of property 'status' are incompatible.
            Type 'string' is not assignable to type '"success"'.
```

Читати варто з кінця: останні рядки називають поле, що не збіглося. Union з `CanonicalErrorResponseSchema` у середині повідомлення розгортається повністю.

## Методи і тіло запиту

| Метод                         | Тіло читається | Схема тіла (`body` у реєстрі, `validator`)                                |
| ----------------------------- | -------------- | ------------------------------------------------------------------------- |
| `post`, `put`, `patch`        | так            | дозволено; для маршруту з таблиці обов'язкова (`route-contracts.spec.ts`) |
| `get`, `delete` (`del`)       | ні             | заборонено: помилка на старті (і помилка типів у `defineRawRoute`)        |
| WS-маршрути (`defineWsRoute`) | —              | дозволено (payload повідомлення)                                          |

- Для часткового оновлення використовуйте `patch`.
- `DELETE` тіло не читає: за [RFC 9110 §9.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5) вміст `DELETE` не має загальновизначеної семантики, і частина проксі його відкидає. Ідентифікатор передавайте через `:param` у шляху контракту (`'/notes/:id'`), додаткові дані — через query контракту і схему `query` в реєстрі.
- Перевірку на старті робить `routesHandler` ([router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)): маршрут `get`/`delete` з `validator`, оголошений в обхід типів, зупиняє запуск з помилкою `Route DELETE … declares a body validator…`. Множини методів — у [body-methods.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/body-methods.ts).
- Як обробляється запит без `Content-Type`, див. [Життєвий цикл запиту](/backend/request-lifecycle#запит-без-content-type).

## Групи та префікси

Маршрути об'єднуються в групи `{ group, prefix, middlewares, rateLimit, description }` (тип `groupRouteItem`):

| Поле          | Обов'язкове | Що робить                                                                                        |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `group`       | так         | масив маршрутів **або вкладених груп**                                                           |
| `prefix`      | так         | сегмент шляху, з якого мають починатися шляхи контрактів усіх маршрутів групи                    |
| `middlewares` | ні          | middleware для всіх маршрутів групи; виконуються перед middleware самого маршруту                |
| `rateLimit`   | ні          | ліміт для кожного маршруту групи, якщо в маршруту немає власного; передається і вкладеним групам |
| `description` | ні          | опис групи                                                                                       |

Елемент списку може бути групою: `{ group: [...], prefix, middlewares, rateLimit, description }`. Приклад з `http-routes.ts`:

```ts
{
  group: [ /* defineRoute({ contract: ..., handler: ... }) */ ],
  description: "Admin user and online routes",
  middlewares: ["session_web", "csrf_guard", "auth_guard", "admin_guard"],
  prefix: "admin",
},
```

Правила злиття (див. `router.ts`):

- шлях маршруту — це `path` його контракту, вже з префіксом групи: роутер не додає префікс, а перевіряє, що `path` з нього починається (`/push-subscriptions/:subscriptionId` у групі `push-subscriptions`). До всього додається глобальний префікс `appConfig.pathPrefix` з env `API_PATH_PREFIX` (за замовчуванням `api`, [`src/config/app.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts)). Отже контракт `/auth/logout` у групі `auth` стає `/api/auth/logout`;
- middleware групи йдуть **перед** middleware маршруту (`middlewares.concat(route.middlewares)`);
- `rateLimit` маршруту має пріоритет над `rateLimit` групи (`route.rateLimit ?? groupRateLimit`). Лічильник ведеться окремо для кожного маршруту (ключ IP + URL), тож ліміт групи діє на кожен її маршрут окремо, а не на групу в сумі. Поверх цього всі API-запити з IP обмежує глобальний L1, див. [Обмеження частоти запитів](/backend/security#обмеження-частоти-запитів).

Набір middleware групи визначає, для кого її маршрути: група з `session_web` і `csrf_guard` обслуговує SPA, група без них — зовнішніх клієнтів API. Маршрут не може вимкнути middleware своєї групи, тому маршрут API не кладуть у веб-групу. Див. [Веб-маршрути і публічний API](/backend/web-and-api-routes).

У репозиторії, наприклад, група `auth` має ліміт `{ windowMs: 60_000, maxRequests: 10 }`, а окремі маршрути всередині — суворіший `maxRequests: 3`. Ліміт перевіряється до читання тіла запиту ([`src/vendor/start/server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)).

## WebSocket-маршрути: `defineWsRoute`

WS-маршрути оголошено через **WS-контракти** ([ADR 0006](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0006-websocket-contracts.md)) — той самий механізм, що й для HTTP: контракт `wsContract<Payload, Відповідь>()(подія)` у [`shared/contracts/ws.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/ws.ts), запис реєстру з ключем `ws <подія>` у [`app/routes/contract-schemas/ws.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/ws.ts) і `defineWsRoute({ contract, handler, … })` з `#app/routes/contract-schemas/index.js`. Шлях контракту — подія під API-префіксом (`/support/support_chat` → подія `api/support/support_chat`), групи дають `prefix`, middleware і `rateLimit`. Сокет-ендпоінт один: `/${pathPrefix}/websocket`. Диспетчер подій — [`src/vendor/utils/routing/ws-api-dispatcher.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts).

```ts
{
  group: [
    defineWsRoute({
      contract: supportWsContracts.chat,
      handler: SupportWsController.chat.bind(SupportWsController),
      description: "Send a message to the support agent",
    }),
  ],
  prefix: "support",
  rateLimit: { windowMs: 60_000, maxRequests: 60 },
},
```

Фронтенд надсилає запит через `callWs(contract, payload)` ([`utils/ws-client.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/ws-client.ts)). Покроково — [Як додати WS-маршрут](/backend/websocket#як-додати-ws-маршрут).

## Інтроспекція маршрутів і API Playground

[`src/vendor/utils/routing/serialize-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/serialize-routes.ts) серіалізує вихідні HTTP- і WS-маршрути (URL, метод, middleware, опис, схеми). Сервер віддає їх на `GET /${pathPrefix}/doc/routes` як JSON `{ httpRoutes, wsRoutes, pathPrefix }`, але **лише** якщо одночасно:

- `APP_ENV=manual-test`;
- `DOC_PAGE=true` (`configApp.docPage`, за замовчуванням `false`);
- `SERVE_STATIC=true`.

Інакше ендпоінт повертає `404`. Зверніть увагу: в [`.env.example`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/.env.example) стоїть `APP_ENV=local`, тож для playground його треба змінити вручну.

Робочий процес:

1. У `packages/backend/.env` встановіть `APP_ENV=manual-test`, `DOC_PAGE=true`, `SERVE_STATIC=true`.
2. З кореня запустіть `pnpm dev:manual_test` — збирає `shared`, потім паралельно запускає backend (`tsx watch`) і [`packages/api-playground`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground) (Vite).
3. Playground (Vue-застосунок) проксіює запити на `http://127.0.0.1:3000` ([`vite.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/vite.config.ts)), завантажує `/api/doc/routes` ([`stores/api-doc.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/src/stores/api-doc.ts)) і дозволяє вручну викликати HTTP- та WS-маршрути.

::: info OpenAPI
OpenAPI у проєкті не використовується, і генерувати його не плануємо. Каталог [`src/openapi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/openapi) містить лише невикористані заготовки: `spec.ts` порожній, `schemas.ts` має тільки закоментований імпорт. Опис API дає `/doc/routes` разом з api-playground.
:::
