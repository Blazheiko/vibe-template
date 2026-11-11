# Маршрутизація

Маршрути бекенду описуються декларативно у двох файлах: HTTP — у [`src/app/routes/http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts), WebSocket — у [`src/app/routes/ws-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/ws-routes.ts). Під час старту роутер ([`src/vendor/start/router.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)) розгортає групи, склеює префікси та списки middleware і реєструє маршрути в uWebSockets.js. Загальний шлях запиту описано на сторінці [Життєвий цикл запиту](/backend/request-lifecycle), ланцюжок перевірок перед обробником — на сторінці [Middleware](/backend/middlewares).

## Маршрут — єдине джерело істини

Усе, що бекенд знає про ендпоінт, записано **в одному об'єкті маршруту**. Окремого файлу з правами доступу, окремого опису API чи окремої реєстрації схем немає: з цього об'єкта все виводиться автоматично.

| Що                             | Звідки береться                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| URL і HTTP-метод               | `url`, `method` + `prefix` груп + `API_PATH_PREFIX`                                                                           |
| Хто має доступ                 | `middlewares` маршруту і всіх його груп                                                                                       |
| Перевірка тіла і query         | `validator`, `queryValidator`, `queryAllowExtra`, `queryArrays` — під час виконання                                           |
| Типи `payload` і `query`       | TypeScript виводить їх з тих самих схем у сигнатуру `handler` — під час компіляції                                            |
| Параметри шляху (`:id`)        | роутер читає їх з `url`                                                                                                       |
| Які `Content-Type` приймаються | `allowedContentTypes` (за замовчуванням лише JSON)                                                                            |
| Ліміт частоти запитів          | `rateLimit` маршруту або групи                                                                                                |
| Документація API               | `GET /<prefix>/doc/routes` і [API Playground](/playground/) серіалізують ті самі об'єкти: URL, метод, middleware, схеми, опис |

Тому правило просте: **щоб змінити поведінку ендпоінту, змініть його маршрут.** Додали `auth_guard` — маршрут закрито і це одразу видно в playground. Змінили схему в `validator` — змінилися і перевірка на сервері, і тип `payload` у контролері, і опис у `/doc/routes`. Розбіжності між «що написано в документації» і «що робить сервер» тут неможливі, бо це один і той самий об'єкт.

Схеми самі живуть у пакеті `shared`, тож вони — єдине джерело істини для контракту між фронтендом і бекендом, а маршрут — для того, як цей контракт підключено до сервера. Детальніше — [Звідки беруться типи](/guide/how-backend-works#звідки-беруться-типи-єдине-джерело-істини).

## HTTP-маршрути: `defineRoute`

Хелпер `defineRoute` лежить у [`src/app/routing/define-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-route.ts). Він загортає ArkType-схеми в `defaultValidator`, застосовує політику зайвих ключів для query і виводить типи `payload`/`query` для handler-а. Тип об'єкта — `RouteConfig` у [`vendor/types/types.d.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/types/types.d.ts).

```ts
defineRoute({
    url: '/upload',
    method: 'post',
    handler: AvatarController.uploadAvatar.bind(AvatarController),
    validator: EmptyFormInputSchema,
    allowedContentTypes: ['multipart'],
    ResponseSchema: ResponseSchemas.UploadAvatarResponseSchema,
    description: 'Upload user avatar',
}),
```

Це реальний маршрут завантаження аватара з групи `avatar` у [`http-routes.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts): він приймає `multipart/form-data` замість JSON.

## Усі поля маршруту

### Обов'язкові

| Поле      | Тип                                               | Що робить                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string`                                          | Шлях відносно префікса групи. Сегменти `:name` стають параметрами шляху: роутер збирає їх у `parametersKey`, а значення приходять у `httpData.params` (`/:provider/callback` → `params.provider`). Скісні риски на краях нормалізуються. |
| `method`  | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` | HTTP-метод. `delete` всередині перетворюється на `del` (так його називає uWebSockets.js). Чи читається тіло, залежить від методу — див. [нижче](#методи-і-тіло-запиту).                                                                  |
| `handler` | `(context) => Payload \| Promise<Payload>`        | Метод контролера, прив'язаний через `.bind(Controller)`. Тип `context.httpData.payload` виводиться з `validator`, тип `context.httpData.query` — з `queryValidator`. Повернене значення стає тілом відповіді.                            |

### Валідація запиту

| Поле                  | Тип                 | За замовчуванням | Що робить                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validator`           | ArkType-схема       | —                | Схема тіла запиту з `shared/schemas`. Дозволена лише для `post`/`put`/`patch`: на `get`/`delete` це помилка типів у `defineRoute` і помилка на старті. Невалідне тіло → `422`. Без `validator` тіло не валідується і `payload` має тип `unknown`.                                                                                    |
| `queryValidator`      | ArkType-схема       | —                | Схема query-рядка. Якщо не задано, `httpData.query === null`, і читати будь-яке поле — помилка TypeScript. Query перевіряється до читання тіла.                                                                                                                                                                                      |
| `queryAllowExtra`     | `boolean`           | `false`          | `false` — суворо: незадекларований ключ → `422` (`onUndeclaredKey('reject')`). `true` — зайві ключі пропускаються, але **видаляються** і до контролера не доходять. Потрібно, коли query формує стороння система (OAuth-callback).                                                                                                   |
| `queryArrays`         | `readonly string[]` | `[]`             | Ключі, які можуть повторюватися (`?tag=a&tag=b`). Вони збираються в `string[]` через `getAll`. Будь-який інший ключ, що трапився двічі, → `422`.                                                                                                                                                                                     |
| `allowedContentTypes` | `BodyKind[]`        | `['json']`       | Які типи тіла приймає маршрут: `json`, `multipart`, `urlencoded`, `text`, `octet`, `other`. Інший `Content-Type` → `415`. Від типу залежить і ліміт розміру тіла (`MAX_JSON_BODY_SIZE`, `MAX_MULTIPART_BODY_SIZE` тощо, див. [Життєвий цикл запиту](/backend/request-lifecycle)). Завантаження аватара використовує `['multipart']`. |

### Доступ і обмеження

| Поле          | Тип                                         | Що робить                                                                                                                                                                                    |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `middlewares` | `string[]`                                  | Імена middleware з `kernel.ts`, які виконуються перед handler. Додаються **після** middleware груп. Невідоме ім'я — помилка `No middleware <name>`. Див. [Middleware](/backend/middlewares). |
| `rateLimit`   | `{ windowMs: number, maxRequests: number }` | Ліміт запитів з одного IP на цей маршрут за вікно `windowMs` мс. Перевищення → `429`. Якщо не задано, діє `rateLimit` найближчої групи. Перевіряється до читання тіла.                       |

### Документація

| Поле             | Тип           | Що робить                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResponseSchema` | ArkType-схема | Схема відповіді з `shared/responses`. Потрапляє в `/doc/routes` (`outputSchema`) і в playground, а під час виконання вона працює як allow-list: невідповідність — `500`, зайві поля — `500` у `strict` і вирізаються в `log` (`RESPONSE_VALIDATION_CONTRACT`, див. [Перевірка відповідей](/backend/response-validation)). Тип результату хендлера TypeScript звіряє з цією схемою — див. [Тип відповіді хендлера](#тип-відповіді-хендлера). |
| `description`    | `string`      | Короткий опис для `/doc/routes` і playground.                                                                                                                                                                                                                                                                                                                                                                                               |

### Службові поля

Ці поля є в типі `RouteConfig`, але **вручну їх не задають**:

| Поле             | Хто заповнює                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `parametersKey`  | роутер — список імен `:param` з `url`                                               |
| `groupRateLimit` | роутер — ліміт групи, успадкований маршрутом                                        |
| `requestBody`    | ніхто: застаріле поле старого формату опису запиту, роутер і сервер його не читають |

## Тип відповіді хендлера

Якщо маршрут оголошує `ResponseSchema`, [`defineRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-route.ts) і [`defineWsRoute`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) вимагають, щоб хендлер повертав **вхідний** тип схеми (`inferIn`) або `Promise` від нього ([route-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/route-response.ts)). Це те саме значення, яке [перевірка відповідей](/backend/response-validation) подає у схему під час виконання. Розбіжність — помилка `tsc` на рядку `handler:` маршруту, на всіх маршрутах, а не лише на викликаних, і також для відповідей без перевірки під час виконання (3xx, 204, 205).

Без `ResponseSchema` хендлер повертає будь-який `Payload`, як і раніше.

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

## Маршрути з контрактом: `defineContractRoute`

Частину маршрутів оголошено через **контракт** з `shared/contracts` ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md)): група `push-subscriptions`, `POST /auth/login`, `GET /admin/users` маршрути моніторингу адмінки (`/admin/users-online`, `/admin/users-online/:id`, `/admin/history-online`, `/admin/usage/text`, `/admin/usage/stats`) і бази знань (`/admin/knowledge-base/*`, крім завантаження скриншота). Контракт — це метод, шлях під API-префіксом і три типи (тіло, query, відповідь); під час виконання він лише `{ method, path }`, тож фронтенд імпортує його без схем і без ArkType.

```ts
// packages/shared/src/contracts/push-subscriptions.ts
export const pushSubscriptionContracts = {
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
}

// packages/backend/src/app/routes/contract-schemas/push-subscriptions.ts
export const pushSubscriptionSchemas = contractSchemas(pushSubscriptionContracts, {
    create: {
        body: CreateSubscriptionInputSchema,
        response: ResponseSchemas.CreateSubscriptionResponseSchema,
    },
    // …one entry per contract of the group
})

// packages/backend/src/app/routes/http-routes.ts
defineContractRoute({
    contract: pushSubscriptionContracts.create,
    handler: PushSubscriptionController.createSubscription.bind(PushSubscriptionController),
    middlewares: ['auth_guard'],
})

// packages/frontend/src/utils/api.ts
callApi(pushSubscriptionContracts.create, { body })
```

- Схеми маршрутів з контрактом живуть в одному **реєстрі** [`app/routes/contract-schemas/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts), по файлу на групу контрактів, за ключем `<метод> <шлях>` контракту. [`contractSchemas`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) вимагає запис для кожного контракту групи й звіряє його з типами контракту: схема тіла іншого маршруту, пропущена чи зайва схема, інша схема відповіді, пропущений контракт — помилка `pnpm typecheck`. Реєстр лежить у бекенді, тож схеми не потрапляють у бандл фронтенду.
- `defineContractRoute` бере `method` і `url` з контракту, а `validator`, `queryValidator` і `ResponseSchema` — із запису реєстру; у таблиці маршрутів вони не вказуються. Тип `payload` і `query` обробника — вихід схем запису. Контракт без запису — помилка компіляції, а на старті — `Route contract … has no entry in the schema registry`.
- Middleware, ліміти, `allowedContentTypes`, `maxBodySize` і група маршруту лишаються конфігурацією бекенду. Маршрут стоїть у групі, префікс якої є початком шляху контракту; інакше сервер не стартує.
- На фронтенді [`callApi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) викликає маршрут контракту поверх наявного транспорту (CSRF, шлюз сесії). Неправильне тіло, параметр шляху чи ключ query — помилка компіляції. Прямі виклики `baseApi.http` поза `utils/api.ts` заборонено правилом ESLint; у самому `utils/api.ts` їхню кількість тримає тест [`api-direct-calls.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/__tests__/api-direct-calls.spec.ts).
- `pnpm check:bundle-graph` (частина `make check`) перевіряє на графі модулів production-збірки, що у бандл фронтенду не потрапили схеми й ArkType.

Решта маршрутів оголошена через `defineRoute` і переходить на контракти групами. Multipart-маршрути (завантаження файлів) контрактів не мають.

## Методи і тіло запиту

| Метод                         | Тіло читається | `validator`                                                   |
| ----------------------------- | -------------- | ------------------------------------------------------------- |
| `post`, `put`, `patch`        | так            | дозволено                                                     |
| `get`, `delete` (`del`)       | ні             | заборонено: помилка типів у `defineRoute` і помилка на старті |
| WS-маршрути (`defineWsRoute`) | —              | дозволено (payload повідомлення)                              |

- Для часткового оновлення використовуйте `patch`.
- `DELETE` тіло не читає: за [RFC 9110 §9.3.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.5) вміст `DELETE` не має загальновизначеної семантики, і частина проксі його відкидає. Ідентифікатор передавайте через `:param` (`url: "/:id"`), додаткові дані — через `queryValidator`.
- Перевірку на старті робить `routesHandler` ([router.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/router.ts)): маршрут `get`/`delete` з `validator`, оголошений в обхід `defineRoute`, зупиняє запуск з помилкою `Route DELETE … declares a body validator…`. Множини методів — у [body-methods.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/body-methods.ts).
- Як обробляється запит без `Content-Type`, див. [Життєвий цикл запиту](/backend/request-lifecycle#запит-без-content-type).

## Групи та префікси

Маршрути об'єднуються в групи `{ group, prefix, middlewares, rateLimit, description }` (тип `groupRouteItem`):

| Поле          | Обов'язкове | Що робить                                                                                        |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `group`       | так         | масив маршрутів **або вкладених груп**                                                           |
| `prefix`      | так         | сегмент шляху, що додається до `url` усіх маршрутів групи                                        |
| `middlewares` | ні          | middleware для всіх маршрутів групи; виконуються перед middleware самого маршруту                |
| `rateLimit`   | ні          | ліміт для кожного маршруту групи, якщо в маршруту немає власного; передається і вкладеним групам |
| `description` | ні          | опис групи                                                                                       |

Елемент списку може бути групою: `{ group: [...], prefix, middlewares, rateLimit, description }`. Приклад з `http-routes.ts`:

```ts
{
  group: [ /* defineRoute(...) */ ],
  description: "Admin user and online routes",
  middlewares: ["session_web", "csrf_guard", "auth_guard", "admin_guard"],
  prefix: "admin",
},
```

Правила злиття (див. `router.ts`):

- префікс групи додається до `url` маршруту, а до всього — глобальний префікс `appConfig.pathPrefix` з env `API_PATH_PREFIX` (за замовчуванням `api`, [`src/config/app.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts)). Отже `/logout` у групі `auth` стає `/api/auth/logout`;
- middleware групи йдуть **перед** middleware маршруту (`middlewares.concat(route.middlewares)`);
- `rateLimit` маршруту має пріоритет над `rateLimit` групи (`route.rateLimit ?? groupRateLimit`). Лічильник ведеться окремо для кожного маршруту (ключ IP + URL), тож ліміт групи діє на кожен її маршрут окремо, а не на групу в сумі. Поверх цього всі API-запити з IP обмежує глобальний L1, див. [Обмеження частоти запитів](/backend/security#обмеження-частоти-запитів).

Набір middleware групи визначає, для кого її маршрути: група з `session_web` і `csrf_guard` обслуговує SPA, група без них — зовнішніх клієнтів API. Маршрут не може вимкнути middleware своєї групи, тому маршрут API не кладуть у веб-групу. Див. [Веб-маршрути і публічний API](/backend/web-and-api-routes).

У репозиторії, наприклад, група `auth` має ліміт `{ windowMs: 60_000, maxRequests: 10 }`, а окремі маршрути всередині — суворіший `maxRequests: 3`. Ліміт перевіряється до читання тіла запиту ([`src/vendor/start/server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/start/server.ts)).

## WebSocket-маршрути: `defineWsRoute`

WS-маршрути визначаються через [`src/app/routing/define-ws-route.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/define-ws-route.ts) і також групуються з `prefix` та `rateLimit`. Поле `url` тут — ім'я події (наприклад `support_chat`), без HTTP-методу. Сокет-ендпоінт один: `/${pathPrefix}/websocket`. Диспетчер подій — [`src/vendor/utils/routing/ws-api-dispatcher.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts).

```ts
{
  group: [
    defineWsRoute({
      url: "support_chat",
      handler: SupportWsController.chat.bind(SupportWsController),
      validator: SupportChatInputSchema,
      ResponseSchema: ResponseSchemas.SupportChatResponseSchema,
      description: "Send a message to the support agent",
    }),
  ],
  prefix: "support",
  rateLimit: { windowMs: 60_000, maxRequests: 60 },
},
```

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
