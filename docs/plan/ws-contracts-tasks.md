# Task list: контракти WebSocket (ADR 0006)

**Статус: у роботі.** Рішення Д-WS1…Д-WS3 прийнято 2026-11-11 — рекомендовані варіанти ([ADR 0006](../adr/0006-websocket-contracts.md#рішення-власника-2026-11-11)).

Фічі: W1 `feat-180`, W2 `feat-181`, W3 `feat-182`. Порядок — W1 → W2 → W3. Шаблони S / D / E / X — як у [code-review-2026-11-10-tasks.md](./code-review-2026-11-10-tasks.md): S — статус-PR і гілка, D — документація в обох мовах, E — повний набір перевірок і evidence, X — PR зі статусом `done`.

## W1 WS Request Correlation · e2e · live

- [x] **W1.S** Шаблон S.
- [x] **W1.1** RED: тест клієнта — два запити однієї події одночасно отримують кожен свою відповідь; зараз другий відхиляється з `Request already in progress`.
      **AC:** тест падає на поточному коді.
- [x] **W1.2** Сервер: `WsMessageSchema` приймає необов'язковий `id` (рядок ≤ 64); диспетчер повторює `id` у відповіді, зокрема в помилці транспорту й відмові ліміту.
      **AC:** тести диспетчера: `id` у відповіді на успіх, `not_found`, невалідний payload, ліміт, виняток; без `id` відповідь як зараз; `id` довше 64 — помилка валідації конверта.
- [x] **W1.3** Фронтенд: очікування за `id`; таймаут і `WsDeliveryUnknownError` без змін; `retireCurrentSocket` відхиляє всі очікування сокета.
      **AC:** W1.1 зелений; наявні тести `useWebSocketConnection.spec.ts` зелені.
- [x] **W1.4** Playground: той самий конверт і кореляція.
      **AC:** тести playground (зокрема `ws-request-errors.spec.ts`) зелені; ручний запит без `id` у WS-модалці працює.
- [x] **W1.D** Шаблон D: `backend/websocket.md` (протокол повідомлень, приклад з `id`), сторінка playground.
- [x] **W1.E** Шаблон E (e2e, live: чат підтримки й підписка адмінки). **W1.X** Шаблон X.

## W2 WS Request Contracts · → W1 · e2e · live

- [ ] **W2.S** Шаблон S.
- [ ] **W2.1** `shared/contracts`: `wsContract<Payload, Response>()(event)` (`kind: 'ws'`, метод `ws`); групи `adminWsContracts`, `supportWsContracts`.
      **AC:** `check:bundle-graph` без схем; тест типів: неправильний payload не компілюється.
- [ ] **W2.2** Реєстр: записи `ws <event>` у `contract-schemas/`; `defineWsRoute({ contract, handler, … })`; старий хелпер → `defineRawWsRoute` для тестів; правило ESLint проти нього поза тестами.
      **AC:** негативні перевірки типів, як у `define-route.spec.ts`; серіалізація маршрутів для playground не змінилася (побайтне порівняння).
- [ ] **W2.3** `route-contracts.spec.ts` проходить і `ws-routes.ts`: маршрут без контракту, запису реєстру чи схеми відповіді — падіння.
      **AC:** тимчасовий маршрут без контракту ламає тест.
- [ ] **W2.4** Фронтенд: `callWs(contract, payload, options?)` у `utils/ws-client.ts` поверх транспорту W1; виклики в `SupportView.vue` і `AdminLayout.vue`; ESLint забороняє `websocketApi(` поза клієнтом; `baseApi.ws` видалено.
      **AC:** тести типів (`@ts-expect-error`): чужий payload, відсутнє поле, поле відповіді, якого немає; тест клієнта на справжньому транспорті W1 (відповідь, помилка транспорту, бізнес-помилка, таймаут).
- [ ] **W2.D** Шаблон D: `backend/websocket.md` («WS-маршрути», «Як додати WS-маршрут»), `backend/routing.md` (згадка WS), ADR 0006 → «прийнято», навичка `backend-feature` (крок WS).
- [ ] **W2.E** Шаблон E (e2e, live). **W2.X** Шаблон X.

## W3 Broadcast Contracts · → W2 · e2e

- [ ] **W3.S** Шаблон S.
- [ ] **W3.1** `shared/contracts/ws/broadcast.ts`: `BroadcastContracts` (лише типи з `BroadcastEventSchemas`).
      **AC:** `check:bundle-graph` без схем.
- [ ] **W3.2** Реєстр guard'ів `satisfies { [E in BroadcastEventName]: Guard<BroadcastPayload<E>> }`; `onBroadcast(event, handler)`; події event bus для broadcast виводяться з `BroadcastContracts`, ручне копіювання полів у `useBroadcastHandler` зникає.
      **AC:** тест типів: подія в `BroadcastEventSchemas` без guard'а не компілюється; тест паритету guard ↔ схема зелений; наявні тести чату й адмінки зелені.
- [ ] **W3.3** `WsServiceMessage` у `shared/ws-client`; мертві обробники `pong` і `connection_closed` прибрано.
      **AC:** тест `classifyWsMessage` з типом; e2e зелені.
- [ ] **W3.D** Шаблон D: `backend/websocket.md` («Контракт подій»), сторінка фронтенду. **W3.E** Шаблон E (e2e). **W3.X** Шаблон X.

## Контроль завершення

- [ ] У `ws-routes.ts` немає маршруту без контракту; поза `utils/ws-client.ts` немає рядкових WS-викликів.
- [ ] Кожна broadcast-подія має контракт типів і guard; ADR 0006 у статусі «прийнято»; цей файл і план code review оновлено.
