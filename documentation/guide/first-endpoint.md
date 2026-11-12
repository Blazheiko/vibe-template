# Перший маршрут

За 15 хвилин ви додасте до бекенду маршрут `GET /api/hello`, який вітає користувача на ім'я. Тут немає бази даних, [міграцій](/reference/glossary#міграція) і [авторизації](/reference/glossary#автентифікація-і-авторизація): лише чотири шари, через які проходить будь-який запит. Після цієї вправи повний туторіал [Як додати фічу](/backend/adding-a-feature) читатиметься значно легше.

::: info Перед читанням

- Проєкт запущено за [Швидким стартом](/guide/getting-started) (`pnpm dev`).
- Прочитано [Як влаштований бекенд](/guide/how-backend-works): ви знаєте, що таке route, controller і service.

:::

## Що вийде

```bash
curl 'http://127.0.0.1:3000/api/hello?name=Olena'
```

```json
{ "status": "ok", "message": "Hello, Olena!" }
```

| Шар        | Файл                                                                  | Що робить                                                                  |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Контракт   | `packages/shared/src/schemas/hello/hello-query.ts`                    | Які [query-параметри](/reference/glossary#query-параметри) приймає маршрут |
| Контракт   | `packages/shared/src/responses/hello-controller.ts`                   | Як виглядає відповідь                                                      |
| Service    | `packages/backend/src/app/services/hello/hello-service.ts`            | Бізнес-правило: як вітати                                                  |
| Controller | `packages/backend/src/app/controllers/http/hello/hello-controller.ts` | Бере query, викликає сервіс, формує відповідь                              |
| Контракт   | `packages/shared/src/contracts/hello.ts`                              | Метод, шлях і типи маршруту для бекенду й фронтенду                        |
| Route      | `packages/backend/src/app/routes/contract-schemas/hello.ts`           | Схеми query й відповіді для контракту                                      |
| Route      | `packages/backend/src/app/routes/http-routes.ts`                      | Зв'язує контракт з контролером                                             |

Увесь код нижче реально додано в чисту копію шаблону і перевірено `pnpm typecheck`, тестом і запитами `curl`.

## Крок 1. Контракт у `shared`

Спершу описуємо, що маршрут приймає і що повертає. Ці описи живуть у пакеті `shared`, щоб їх могли імпортувати і бекенд, і фронтенд.

**Вхід.** Параметр `name` необов'язковий (`?` у ключі), від 1 до 50 символів. Мова схем — [arktype](https://arktype.io/): рядок `'1 <= string <= 50'` читається як «рядок довжиною від 1 до 50».

```ts
// packages/shared/src/schemas/hello/hello-query.ts
import { type } from '@arktype/type'

export const HelloQuerySchema = type({
    'name?': '1 <= string <= 50',
})

export type HelloQuery = typeof HelloQuerySchema.infer
```

`HelloQuery` — звичайний TypeScript-тип `{ name?: string }`, виведений зі схеми. Схема перевіряє дані під час виконання, тип — під час компіляції. Пишете одне, отримуєте обидва.

Додайте рядок у кінець `packages/shared/src/schemas/index.ts`:

```ts
export { HelloQuerySchema, type HelloQuery } from './hello/hello-query.js'
```

**Відповідь.** Або успіх з повідомленням, або стандартна помилка шаблону (`CanonicalErrorResponseSchema`):

```ts
// packages/shared/src/responses/hello-controller.ts
import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

export const HelloResponseSchema = type.or(
    { status: "'ok'", message: 'string' },
    CanonicalErrorResponseSchema,
)
export type HelloResponse = typeof HelloResponseSchema.infer
```

І рядок у кінець `packages/shared/src/responses/index.ts`:

```ts
export * from './hello-controller.js'
```

Dev-сервер бекенду (`pnpm dev`) бачить зміни в `packages/shared/src` одразу, але `typecheck`, тести й `start` читають зібраний `dist/`, тож перед ними перезберіть пакет:

```bash
pnpm --filter shared build
```

## Крок 2. Service

Сервіс — це місце для бізнес-правил. Наше правило: без імені вітаємо світ, ім'я обрізаємо від пробілів, а ім'я з одних пробілів вважаємо помилкою.

```ts
// packages/backend/src/app/services/hello/hello-service.ts
import { Result } from 'better-result'
import type { AppResult } from '#app/services/shared/errors.js'
import { badRequest } from '#app/services/shared/errors.js'

export const helloService = {
    greet(name?: string): AppResult<{ message: string }> {
        if (name === undefined) {
            return Result.ok({ message: 'Hello, world!' })
        }

        const trimmed = name.trim()
        if (trimmed === '') {
            return Result.err(badRequest('Name must not be blank'))
        }

        return Result.ok({ message: `Hello, ${trimmed}!` })
    },
}
```

Зверніть увагу:

- сервіс нічого не знає про HTTP: ні запиту, ні статус-кодів. Його можна викликати з HTTP-контролера, з WebSocket або з тесту;
- помилка не кидається через `throw`, а повертається як `Result.err(...)`. Тип `AppResult` змушує того, хто викликає, перевірити результат. Хелпер `badRequest` з [errors.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts) пізніше перетвориться на HTTP `400`.

Чому порожній рядок не дійде сюди, а рядок з пробілів дійде? Схема з кроку 1 відсікає `name=` (довжина 0), а `name=%20%20` має довжину 2 і проходить. Перевірка форми даних — у схемі, перевірка змісту — у сервісі.

## Крок 3. Controller

Контролер перекладає HTTP на виклик сервісу і назад. Що є в `context` і як з ним працювати — див. [HttpContext докладно](/backend/controllers#httpcontext-докладно).

```ts
// packages/backend/src/app/controllers/http/hello/hello-controller.ts
import type { HttpContext } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { helloService } from '#app/services/hello/hello-service.js'
import type { HelloResponse } from 'shared/responses'
import type { HelloQuery } from 'shared/schemas'

export default {
    hello(context: HttpContext<unknown, HelloQuery>): HelloResponse {
        const result = helloService.greet(context.httpData.query.name)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', message: result.value.message }
    },
}
```

- `HttpContext<unknown, HelloQuery>`: перший параметр — тип тіла запиту (у GET його немає), другий — тип query. Завдяки йому `context.httpData.query.name` має тип `string | undefined`.
- `mapControllerError` виставляє HTTP-статус за типом помилки (`badRequest` → `400`) і формує стандартну відповідь з `code` і `message`.
- Тип повернення `HelloResponse` береться зі `shared`: якщо повернути щось інше, `pnpm typecheck` це покаже.

## Крок 4. Route

Залишилось сказати серверу, що `GET /api/hello` обробляє наш контролер. Кожен HTTP-маршрут шаблону оголошено через **контракт** ([Маршрутизація](/backend/routing#http-маршрути-defineroute)), тож тут три невеликі зміни.

**Контракт.** Метод, повний шлях під префіксом `api` і типи query й відповіді. Схеми імпортуються лише як типи, тому фронтенд може імпортувати контракт без них:

```ts
// packages/shared/src/contracts/hello.ts
import type { HelloQuerySchema } from '../schemas/hello/hello-query.js'
import type { HelloResponse } from '../responses/hello-controller.js'
import { contract } from './core.js'

export const helloContracts = {
    hello: contract<undefined, typeof HelloQuerySchema.inferIn, HelloResponse>()('get', '/hello'),
} as const
```

Додайте рядок у кінець `packages/shared/src/contracts/index.ts` і знову виконайте `pnpm --filter shared build`:

```ts
export { helloContracts } from './hello.js'
```

**Схеми маршруту.** Бекенд тримає схеми кожного контракту в реєстрі `app/routes/contract-schemas/`. `contractSchemas` звіряє запис із типами контракту: якщо ключі `HelloQuerySchema` розійдуться з query контракту, `pnpm typecheck` це покаже.

```ts
// packages/backend/src/app/routes/contract-schemas/hello.ts
import { HelloQuerySchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { helloContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const helloSchemas = contractSchemas(helloContracts, {
    hello: { query: HelloQuerySchema, response: ResponseSchemas.HelloResponseSchema },
})
```

Розгорніть його в `contractSchemaRegistry` у `packages/backend/src/app/routes/contract-schemas/index.ts`:

```ts
import { helloSchemas } from './hello.js'
// ...
export const contractSchemaRegistry = {
    // ...
    ...helloSchemas,
}
```

**Маршрут.** Відкрийте [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts). `defineRoute` там уже імпортовано з `#app/routes/contract-schemas/index.js`; додайте імпорт контролера і `helloContracts` до наявного імпорту з `shared/contracts`:

```ts
import HelloController from '#app/controllers/http/hello/hello-controller.js'
// ...
import {
    // ...
    supportContracts,
    helloContracts,
} from 'shared/contracts'
```

Потім додайте групу останнім елементом масиву, перед `] satisfies routeList`:

```ts
    {
        group: [
            defineRoute({
                contract: helloContracts.hello,
                handler: HelloController.hello.bind(HelloController),
                description: 'Say hello',
            }),
        ],
        description: 'Hello routes',
        prefix: 'hello',
    },
```

- Шлях контракту `/hello` + глобальний префікс `api` = `/api/hello`. `prefix: 'hello'` групи має бути початком шляху контракту, інакше сервер не стартує.
- Схема `query` із запису реєстру — ядро перевірить query за нею **до** виклику контролера. Невідомі параметри відхиляються (строга політика за замовчуванням).
- `middlewares` немає, тож маршрут публічний: ні сесії, ні входу не потрібно. Як закрити маршрут для незалогінених, показано в [Як додати фічу](/backend/adding-a-feature#крок-8-контракт-і-реєстрація-маршрутів).
- Схема `response` описує відповідь для документації API та [API Playground](/playground/). Під час розробки сервер ще й перевіряє за нею кожну відповідь контролера: якщо вона не збігається зі схемою, клієнт отримає `500`, а в лозі буде шлях до поля, що не збіглося. Див. [Перевірка відповідей](/backend/response-validation). Ще до запуску TypeScript звіряє зі схемою тип, який повертає контролер, тому анотацію `HelloResponse` у контролері лишаємо ([Тип відповіді хендлера](/backend/routing#тип-відповіді-хендлера)).

`pnpm dev` перезапустить бекенд сам, коли ви збережете файл.

## Крок 5. Перевірка

```bash
B=http://127.0.0.1:3000/api
curl -s "$B/hello"
curl -s "$B/hello?name=Olena"
```

```json
{"status":"ok","message":"Hello, world!"}
{"status":"ok","message":"Hello, Olena!"}
```

Тепер зламайте запит і подивіться, хто його зупинить:

| Запит                    | Статус | Хто відповів                      | Тіло відповіді (скорочено)                                                   |
| ------------------------ | ------ | --------------------------------- | ---------------------------------------------------------------------------- |
| `?name=%20%20` (пробіли) | `400`  | сервіс, правило «не порожнє ім'я» | `{"status":"error","message":"Name must not be blank","code":"bad_request"}` |
| `?name=`                 | `422`  | схема: довжина менша за 1         | `"code":"validation_failed"`, `"messages":["name must be non-empty"]`        |
| `?nick=Olena`            | `422`  | схема: невідомий параметр         | `"messages":["nick must be removed"]`                                        |
| `?name=` + 51 символ     | `422`  | схема: довжина більша за 50       | `"messages":["name must be at most length 50 (was 51)"]`                     |

Повна відповідь `422`:

```json
{
    "status": "error",
    "code": "validation_failed",
    "message": "Validation failure",
    "details": {
        "kind": "validation",
        "messages": ["name must be non-empty"],
        "issues": [{ "path": "name", "message": "name must be non-empty" }]
    }
}
```

`422` приходить ще до вашого контролера: ядро перевіряє query раніше (див. [Як влаштований бекенд](/guide/how-backend-works#шлях-одного-запиту)). Ваш код отримує лише дані, які вже відповідають схемі.

## Крок 6 (за бажанням). Тест сервісу

Сервіс — звичайна функція без HTTP і бази, тож тест простий:

```ts
// packages/backend/src/app/services/hello/hello-service.spec.ts
import { Result } from 'better-result'
import { describe, expect, it } from 'vitest'
import { helloService } from './hello-service.js'

describe('helloService.greet', () => {
    it('greets the world when no name is given', () => {
        const result = helloService.greet()

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.message).toBe('Hello, world!')
        }
    })

    it('greets by trimmed name', () => {
        const result = helloService.greet('  Olena ')

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.message).toBe('Hello, Olena!')
        }
    })

    it('rejects a blank name with a BadRequest error', () => {
        const result = helloService.greet('   ')

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error._tag).toBe('BadRequest')
        }
    })
})
```

```bash
cd packages/backend && npx vitest run src/app/services/hello
```

Разом з цим тестом запустіть `src/app/layering.spec.ts`: він перевіряє, що шари не порушують правил імпорту (наприклад, контролер не звертається до репозиторію напряму).

## Що ви щойно використали

| Поняття                  | Де в цій вправі                             | Детальніше                                                             |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| Контракт у `shared`      | `HelloQuerySchema`, `HelloResponseSchema`   | [Пакет shared](/shared/), [Валідація](/backend/validation)             |
| Runtime-валідація        | схема `query` у реєстрі → `422`             | [Валідація](/backend/validation)                                       |
| `Result` замість `throw` | `Result.ok` / `Result.err(badRequest(...))` | [Сервіси](/backend/services)                                           |
| Мапінг помилок           | `mapControllerError` → `400`                | [Контролери](/backend/controllers)                                     |
| Оголошення маршруту      | `defineRoute({ contract })` у групі         | [Маршрутизація](/backend/routing) і [Middleware](/backend/middlewares) |

Чого тут ще немає: бази даних, сесії і захисту маршруту. Усе це додає наступний крок.

::: tip Наступний крок
[Як додати фічу](/backend/adding-a-feature): ресурс `notes` з таблицею, міграцією, репозиторієм, трансформером і маршрутами лише для залогінених.
:::
