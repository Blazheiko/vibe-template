# Пакет shared

`packages/shared` містить контракти, спільні для backend і frontend: ArkType-схеми вводу, схеми та інтерфейси відповідей, коди помилок, branded-типи, enum-и мов і утиліти. Завдяки цьому сервер і клієнт імпортують ту саму схему чи тип, а не тримають дві копії.

```mermaid
flowchart LR
    S[packages/shared] -->|dist + workspace:*| B[packages/backend]
    S -->|dist + workspace:*| F[packages/frontend]
```

## package.json і збірка

Дані з [packages/shared/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/package.json):

- `name: "shared"`, `private: true`, `type: "module"`;
- `exports` має кореневий вхід `.` і підшляхи `./brands`, `./schemas`, `./responses`, `./errors`, `./enums`, `./utils`, `./guards`, `./limits`, `./patterns`. Кожен вказує на `dist/<розділ>/index.js` і `.d.ts`;
- `build`: `tsc --build`, `dev`: `tsc --build --watch`. [tsconfig.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/tsconfig.json) збирає `src` у `dist` (`composite: true`);
- залежності в рантаймі: `@arktype/type`, `@ark/util`, `libphonenumber-js`.

Backend і frontend підключають пакет як `"shared": "workspace:*"` ([backend/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json), [frontend/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json)).

Оскільки `exports` вказують лише на `dist`, без збірки пакета споживачі його не знайдуть. Тому кореневий `pnpm dev` спочатку запускає `build:shared` (`pnpm --filter shared build`), потім збирає backend і лише тоді паралельно стартує dev-сервери ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)). Див. також [«Скрипти»](/reference/scripts).

## Структура `src/`

| Розділ                                                                                                   | Вміст                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [brands](https://github.com/Blazheiko/vibe-template/tree/main/packages/shared/src/brands)                | branded-примітиви: у [primitives.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/brands/primitives.ts), напр., `EmailSchema = type("string.email").brand("Email")` і `PositiveIntSchema`, а в [ids.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/brands/ids.ts) лежить `EntityIdSchema`                                                                                                                                                                                                                              |
| [enums](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/enums/languages.ts)     | `APP_LOCALE_CODES` (`as const`), мапи назв мов і функції `resolveLanguageName`, `resolveLanguageCode`, `isAppLocaleCode` тощо                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [errors](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/errors/error-codes.ts) | об'єкт `ErrorCode` (`BadRequest: "bad_request"`, `ValidationFailed: "validation_failed"`, `CsrfInvalid: "csrf_invalid"`…) і список `ErrorCodeValues`, без runtime-залежності від ArkType (модуль імпортує фронтенд). `ErrorCodeSchema` — у `responses`                                                                                                                                                                                                                                                                                                                           |
| [guards](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/guards/index.ts)       | [ws-channels.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/guards/ws-channels.ts): whitelist WS-каналів `WS_CHANNELS` (`admin`), тип `WsChannel` і guard `isWsChannel(value: unknown)` без залежностей; його використовує `broadcastToChannel`, а фронтенд може імпортувати з `shared/guards`                                                                                                                                                                                                                                                     |
| [responses](https://github.com/Blazheiko/vibe-template/tree/main/packages/shared/src/responses)          | схеми та інтерфейси відповідей по контролерах (`auth-controller.ts`, `main-controller.ts`, `admin-user-controller.ts`…). Канонічна помилка лежить в [error-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/error-response.ts): `CanonicalErrorResponseSchema` з `status: "'error'"`, `code`, `message` і необов'язковими `reason`/`details`/`csrfToken`                                                                                                                                                                          |
| [schemas](https://github.com/Blazheiko/vibe-template/tree/main/packages/shared/src/schemas)              | ArkType-схеми вводу за доменами (`auth`, `main`, `support`, `push-subscription`, `query`, `ws`, `activity`, `common`). Кожна схема експортується разом із типом, напр. `LoginInputSchema` / `LoginInput` у [auth/login.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts). У `ws` — реєстр payload'ів push-подій `BroadcastEventSchemas` з типами `BroadcastEventName` і `BroadcastPayload<E>` ([broadcast-events.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/ws/broadcast-events.ts)) |
| [utils](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/phone.ts)         | `normalizePhoneNumber(input, defaultCountry?)` (на `libphonenumber-js`, повертає E.164 або кидає `PhoneNormalizationError`) і `looksLikePhoneNumber`                                                                                                                                                                                                                                                                                                                                                                                                                             |

Про правила написання схем (`'+': 'reject'`, query-морфи) див. [«Валідація»](/backend/validation). Чому DTO трансформерів не беруться з `shared/responses`, пояснено в розділі [«Трансформери»](/backend/transformers).

- Два підшляхи без жодної бібліотеки, які безпечно тягнути в браузер: [`limits`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/limits/index.ts) (числові ліміти: довжина повідомлення чату, розмір сторінки історії, `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`) і [`patterns`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/patterns/index.ts) (`ENTITY_ID_PATTERN`, `looksLikePhoneNumber`; `shared/utils` тягне `libphonenumber-js`, тому браузер бере форму номера звідси). Схеми й клієнт мають одне джерело, а тест у `contracts.test.js` тримає їх разом.
- [src/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/index.ts) реекспортує всі розділи, зокрема `guards`; підшляхи з `exports` (`shared/guards` тощо) працюють так само.
- `EntityIdSchema` — справжній branded-тип: `type(/^[1-9]\d*$/).brand('EntityId')`. Рядок стає `EntityId` лише після перевірки схемою; присвоєння звичайного рядка — помилка typecheck (перевіряє [`shared-brands.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/shared-brands.spec.ts) у backend).

## Використання в backend

Маршрути беруть схеми вводу із `shared/schemas`, а схеми відповідей імпортують з `shared/responses` як простір імен ([http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts)):

```ts
import * as ResponseSchemas from 'shared/responses'

defineRoute({
    url: '/login',
    method: 'post',
    handler: AuthController.login.bind(AuthController),
    validator: LoginInputSchema,
    ResponseSchema: ResponseSchemas.LoginResponseSchema,
})
```

`ResponseSchema` у рантаймі не перевіряється, а потрапляє лише в doc-серіалізацію маршрутів (див. [«Валідація»](/backend/validation)). Контролери імпортують лише типи, напр. `import type { SupportChatInput } from 'shared/schemas'` у [ws/support-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/ws/support-controller.ts). Сервіси користуються утилітами, як-от `resolveLanguageName` з `shared/enums` у [support-llm-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/support/support-llm-service.ts).

## Використання у frontend

- API-клієнт [utils/api.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api.ts) типізується через `shared/responses`, `shared/schemas` і `import type { ErrorCode } from 'shared/errors'`;
- [response-normalizer.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/response-normalizer.ts) і компоненти (наприклад, [AuthModals.vue](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/components/AuthModals.vue)) порівнюють коди помилок зі значеннями `ErrorCode`;
- [useBroadcastHandler.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/composables/useBroadcastHandler.ts) перевіряє payload broadcast-подій guard'ами з [ws-payload-guards.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/ws-payload-guards.ts), а не схемами: ArkType у рантаймі збільшив би бандл і порушив CSP (JIT через `new Function`). Типи guard'ів — `BroadcastPayload<E>` з `shared/schemas`; тест паритету проганяє кожен guard і схему реєстру `BroadcastEventSchemas` на тих самих фікстурах (ArkType імпортує лише тест);
- [plugins/i18n.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/plugins/i18n.ts) і [useLocale.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/composables/useLocale.ts) беруть `APP_LOCALE_CODES` і `resolveLanguageCode` з `shared/enums`;
- адмінські view імпортують типи `AdminUserListItem`, `AdminOnlineUserDetail` тощо з `shared/responses`.

## Тести

Скрипт `test` виконує `pnpm build && node --test test/*.test.js`, тобто вбудований раннер Node проганяє JS-файли з `test/` на зібраному `dist`. Кореневий `pnpm test` (`pnpm -r test`) запускає його разом з іншими пакетами.

Що покрито:

| Файл                                                                                                                 | Що перевіряє                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [languages.test.js](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/test/languages.test.js)     | `resolveLanguageCode` (локаль браузера → код застосунку або `en`), `isAppLocaleCode`, назви мов для кожного `APP_LOCALE_CODES`                                                                                      |
| [phone.test.js](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/test/phone.test.js)             | `normalizePhoneNumber` → E.164 і відмова для порожніх/невалідних, `looksLikePhoneNumber`                                                                                                                            |
| [ws-channels.test.js](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/test/ws-channels.test.js) | `isWsChannel`                                                                                                                                                                                                       |
| [contracts.test.js](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/test/contracts.test.js)     | `ErrorCodeSchema` приймає рівно значення `ErrorCode`, `EntityIdSchema` і `ENTITY_ID_PATTERN`, `looksLikePhoneNumber`, ліміти пароля й повідомлень та `'+': 'reject'` вибраних схем вводу, реекспорт guards з кореня |

## Як додати контракт

1. Схему вводу покладіть у `src/schemas/<домен>/<name>.ts`, а схему чи інтерфейс відповіді у `src/responses/<controller>.ts`. Поруч зі схемою експортуйте тип (`typeof X.infer`).
2. Додайте експорт в `index.ts` відповідного розділу (напр. [schemas/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/index.ts)). Новий розділ потрібно додати і в `src/index.ts`, і в `exports` у `package.json`.
3. Перезберіть пакет: `pnpm build:shared` (або `pnpm --filter shared dev` у watch-режимі). Інакше backend і frontend побачать стару версію `dist`.
4. Підключіть схему в маршруті (`validator`, `ResponseSchema`) і далі дійте за кроками з [«Додавання фічі»](/backend/adding-a-feature).
