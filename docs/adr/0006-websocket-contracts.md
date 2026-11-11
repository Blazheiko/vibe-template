# ADR 0006: контракти WebSocket — запити, відповіді, broadcast-події, кореляція

- **Статус:** запропоновано 2026-11-11 (feat-171, C6 плану code review 2026-11-10). Реалізація — після рішення власника щодо Д-WS1…Д-WS3 нижче.
- **Продовжує:** [ADR 0005](./0005-route-contracts.md) (контракти HTTP-маршрутів, цільовий стан досягнуто в feat-170).
- **Task list:** [`docs/plan/ws-contracts-tasks.md`](../plan/ws-contracts-tasks.md).

## Контекст

HTTP-маршрути після ADR 0005 оголошено лише через контракти: метод, шлях і типи — у `shared/contracts`, схеми — у серверному реєстрі, фронтенд викликає `callApi`. WebSocket лишився в стані «до контрактів». Стан на `main` після feat-170:

**Запити.** Чотири WS-маршрути в [`ws-routes.ts`](../../packages/backend/src/app/routes/ws-routes.ts) (`admin/subscribe_online_users`, `admin/unsubscribe_online_users`, `support/support_open_chat`, `support/support_chat`) оголошено через `defineWsRoute({ url, validator, ResponseSchema, handler })` — схеми в маршруті, як колись у HTTP. Фронтенд викликає їх рядком: `websocketApi('support/support_chat', { … })` у `SupportView.vue` і `AdminLayout.vue`. Тип payload не перевіряється, відповідь — `WebsocketMessage` з `payload: unknown`. Перейменування маршруту на бекенді компілятор не помітить.

**Кореляція.** Клієнт ([`useWebSocketConnection.ts`](../../packages/frontend/src/composables/useWebSocketConnection.ts), `websocketApi`) тримає очікування відповіді за **назвою події**: `apiResolve[event]`. Відповідь повторює `event` і `timestamp` запиту ([протокол](../../documentation/backend/websocket.md#протокол-повідомлень)). Наслідки:

- одночасно може бути лише **один** запит на подію — другий відхиляється з `Request already in progress`;
- `timestamp` повертається, але для зіставлення не використовується; два запити з однаковою подією й мілісекундою не розрізнити;
- чат підтримки обходить це власним `clientMessageId` у payload і в broadcast-подіях.

**Broadcast-події.** Тут контракт уже є наполовину. `BroadcastEventSchemas` ([`broadcast-events.ts`](../../packages/shared/src/schemas/ws/broadcast-events.ts)) — реєстр подія → схема payload; бекенд перевіряє кожну подію перед надсиланням, а `BroadcastMessage` не дає `tsc` пропустити чужий payload. На фронтенді — ручні guard'и ([`ws-payload-guards.ts`](../../packages/frontend/src/utils/ws-payload-guards.ts), без ArkType у бандлі) і тест паритету guard ↔ схема. Але:

- [`useBroadcastHandler.ts`](../../packages/frontend/src/composables/useBroadcastHandler.ts) — мапа `Partial<Record<string, handler>>`: подію без обробника компілятор не покаже, назва події — рядок;
- кожен обробник вручну перекладає payload в подію event bus ([`event-bus.ts`](../../packages/frontend/src/utils/event-bus.ts)), тобто тип описано вдруге;
- тип payload на клієнті береться з guard'а, а не з контракту.

**Службові повідомлення.** Сервер надсилає дві службові події: `service:connection_established` і `service:error` ([`ws-handlers.ts`](../../packages/backend/src/vendor/utils/network/ws-handlers.ts)). Heartbeat — не подія, а сирий текст `ping` → `pong`. Клієнт розпізнає `service:*` через `classifyWsMessage` у `shared/ws-client`, але має ще обробники `pong` і `connection_closed`, яких сервер не надсилає (мертвий код).

**Playground** ([`api-playground`](../../packages/api-playground/src/composables/useWebSocketConnection.ts)) має власний WS-клієнт з тим самим протоколом і тією самою кореляцією за подією.

## Рішення

### 1. Контракт WS-запиту — той самий тип, інший `kind`

```ts
// packages/shared/src/contracts/ws/support.ts
import type { SupportChatInputSchema } from '../../schemas/support/support-chat.js'
import type { SupportChatResponse } from '../../responses/support-controller.js'
import { wsContract } from '../core.js'

export const supportWsContracts = {
    chat: wsContract<typeof SupportChatInputSchema.inferIn, SupportChatResponse>()(
        'support/support_chat',
    ),
} as const
```

- `wsContract<Payload, Response>()(event)` — `RouteContract` з `kind: 'ws'`, методом `ws` і шляхом-подією (без `API_PATH_PREFIX`, як HTTP-шлях). Під час виконання — `{ kind, method, path }`, схем у бандлі немає (перевіряє `check:bundle-graph`).
- Схеми — у тому самому серверному реєстрі `app/routes/contract-schemas/` (`contractSchemas(supportWsContracts, { chat: { body, response } })`): ключ `ws <event>` не перетинається з HTTP. Перевірки запису (вхід схеми = тип payload, успішні гілки відповіді = тип відповіді) — ті самі.
- Бекенд: `defineWsRoute({ contract, handler, middlewares?, rateLimit? })`. Маршрут без контракту в `ws-routes.ts` ловить розширений `route-contracts.spec.ts`; `defineRawWsRoute` лишається тестам, як `defineRawRoute`.
- Фронтенд: `callWs(contract, payload, options?)` у `utils/ws-client.ts` повертає `Promise<WsReply<ResponseOf<C>>>`; рядковий `websocketApi(route, …)` поза клієнтом забороняє ESLint (як `baseApi.http`).

### 2. Кореляція — `id` запиту, а не назва події (Д-WS1)

Конверт запиту отримує поле `id` (рядок, ≤ 64 символи), відповідь його повторює:

```json
{ "event": "api/support/support_chat", "id": "k3f9…", "timestamp": 1760000000000, "payload": { … } }
{ "event": "api/support/support_chat", "id": "k3f9…", "timestamp": 1760000000000, "status": "200", "error": null, "data": { … } }
```

- Клієнт тримає очікування за `id` (генератор як `newClientMessageId` у `utils/support-send.ts`: `crypto.randomUUID()` з запасним варіантом), тож кілька запитів однієї події можуть летіти одночасно; `Request already in progress` зникає.
- Сервер `id` не тлумачить, лише повертає; `WsMessageSchema` ([`ws-message-validator.ts`](../../packages/backend/src/app/validate/ws-message-validator.ts)) приймає його як необов'язковий рядок з обмеженням довжини. Без `id` відповідь будується як зараз — для ручних повідомлень у playground.
- Таймаут і `WsDeliveryUnknownError` («доставка невідома») лишаються: таймаут означає, що результат невідомий, а не що запит не виконано.
- `clientMessageId` чату підтримки лишається: він зв'язує **broadcast-події** з повідомленням, а не відповідь із запитом. Об'єднувати їх не пропоную — це різні життєві цикли (відповідь на запит одна, токенів відповіді багато).
- Зворотна сумісність не потрібна (шаблон без production): обидва клієнти й сервер міняються в одному PR.

### 3. Broadcast-події — контракт типів, guard'и лишаються (Д-WS2)

```ts
// packages/shared/src/contracts/ws/broadcast.ts — лише типи
export type BroadcastContracts = {
    readonly [E in BroadcastEventName]: BroadcastPayload<E>
}
```

- Реєстр `BroadcastEventSchemas` лишається джерелом істини на бекенді (перевірка перед надсиланням не змінюється).
- Фронтенд отримує `onBroadcast(event, handler)` з типом payload із контракту і реєстр guard'ів `satisfies { [E in BroadcastEventName]: Guard<BroadcastPayload<E>> }`: нова подія без guard'а — помилка `tsc`, а не мовчазне ігнорування. Тест паритету guard ↔ схема лишається (він ловить розбіжність, яку типи не бачать: межі, формати).
- `useBroadcastHandler` перестає вручну копіювати поля в event bus: подія event bus з тим самим ім'ям отримує payload контракту як є; тип події event bus виводиться з `BroadcastContracts`.
- Перевірка на клієнті під час виконання лишається guard'ами без ArkType: payload приходить від сервера, але без перевірки фронтенд упав би на першій розбіжності версій вкладки й бекенду після деплою.

### 4. Відповідь і помилки

- Тип відповіді `callWs` — розмічений union: `{ ok: true; data: Success }` | `{ ok: false; error: WsErrorEnvelope }` (транспортна помилка: `status: 'error'`, `data: null`) | бізнес-помилка в `data` (`status: 'error'` у `CanonicalErrorResponse`). Розгалуження за `status`, як після `isSuccessfulResponse` у HTTP.
- Перевірка відповіді на сервері (`responseCheck`) не змінюється: перевіряється пряма відповідь маршруту, broadcast — окремо (рішення 3).

### 5. Службові повідомлення — поза контрактами (Д-WS3)

`service:*` — протокол транспорту з фіксованим набором (`connection_established`, `error`), а не маршрути. Їх описує тип `WsServiceMessage` у `shared/ws-client` поруч із `classifyWsMessage`; реєстру й схем не потрібно. Мертві обробники клієнта `pong` і `connection_closed` прибирає W3. Heartbeat лишається сирим текстом `ping`/`pong`: він не проходить JSON-розбір, а оновлення токена після нього має окремий бюджет (feat-149), і так має лишатися.

## Розглянуті альтернативи

- **JSON-RPC 2.0 замість власного конверта.** Дає `id` і стандартні помилки, але міняє весь протокол обох клієнтів, документацію й `ws-error-envelope` заради поля `id`. Відхилено: рішення 2 бере з нього лише кореляцію.
- **AsyncAPI-специфікація + генерація.** Як OpenAPI в ADR 0005: другий формат поруч з ArkType і крок генерації. Має сенс лише за зовнішніх споживачів WS.
- **Кореляція за `timestamp`.** Уже повертається, але мілісекунда не унікальна в межах події й не підходить як ключ; `id` прямо це виражає.
- **Схеми broadcast-подій у бандлі фронтенду.** Відхилено з тієї самої причини, що в ADR 0005: ArkType у бандлі. Guard'и + тест паритету вже працюють.
- **Окремий реєстр для WS-схем.** Відхилено: ключ `ws <event>` у спільному реєстрі достатньо відокремлює, а машинерія (`contractSchemas`, перевірки) та сама.

## Наслідки

- Перейменування WS-маршруту, інший payload чи інша відповідь — помилка `pnpm typecheck` на обох сторонах, як для HTTP.
- Кілька одночасних запитів однієї події стають можливими; поведінка чату підтримки (свій `clientMessageId`) не змінюється.
- Новий broadcast без guard'а на фронтенді не компілюється.
- Протокол змінюється (поле `id`): playground, документація `backend/websocket.md` і приклад у playground оновлюються разом.
- `baseApi.ws` у `frontend/src/utils/base-api.ts` не має викликів і зникає разом із рядковими викликами.

## Оцінка

| Фіча | Що                                                                                                                                            | Розмір |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W1   | Кореляція за `id`: конверт, сервер повторює `id`, обидва клієнти тримають очікування за `id`, документація протоколу                          | S      |
| W2   | Контракти WS-запитів: `wsContract`, записи реєстру, `defineWsRoute({ contract })`, `callWs`, 4 маршрути, ESLint, тест покриття `ws-routes.ts` | M      |
| W3   | Broadcast: `BroadcastContracts`, вичерпний реєстр guard'ів, `onBroadcast`, event bus з типів контракту                                        | S      |

Порядок: W1 → W2 (типізований клієнт будується одразу на `id`) → W3 (незалежна від W2, але після неї, бо `useWebSocketConnection` змінюють обидві). Разом — приблизно як C7 + одна група C4.

## Рішення, потрібні від власника

- **Д-WS1.** Кореляція за `id` запиту (рекомендую) чи лишити «один запит на подію» й типізувати лише payload і відповідь.
- **Д-WS2.** Broadcast: контракт типів + вичерпний реєстр guard'ів (рекомендую) чи лишити як є (схеми + тест паритету вже ловлять розбіжність payload).
- **Д-WS3.** Службові `service:*` — тип у `shared/ws-client` без реєстру (рекомендую) чи окремі контракти.
