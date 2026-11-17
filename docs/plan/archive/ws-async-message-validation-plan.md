# feat-049: перевірка асинхронних WS-повідомлень і broadcast

> Статус: реалізовано на гілці `feat/ws-async-message-validation`. Дата: 2026-10-30. Залежить від feat-044 (і використовує
> перевірку feat-046 / feat-047).

## 1. Задача

Перевірка відповідей (feat-044, feat-046) охоплює HTTP-відповіді й **пряму** відповідь
WS-обробника. Повідомлення, які сервер шле пізніше, не перевіряються зовсім:

- відповіді support-агента, що надходять потоком після `support_chat` / `support_open_chat`;
- події адмінського каналу про онлайн-користувачів.

Усі вони йдуть через `broadcastService`
(`packages/backend/src/app/services/communication/broadcast-service.ts`), який приймає довільний
рядок `event` і довільний `Payload`. Немає ні контракту типів, ні перевірки під час виконання, ні
allow-list: зайве поле в payload дійде до клієнта.

Мета: кожна broadcast-подія має схему в `shared`; TypeScript не дає надіслати подію, якої немає в
реєстрі, або payload, що не відповідає її схемі; під час виконання payload проходить ту саму
перевірку, що й відповіді (allow-list, `strict` / `log`).

## 2. Що показав аналіз

Подій п'ять, усі шлються з двох сервісів:

| Подія                      | Звідки                                   | Payload                                                     | Схема в `shared`                                                                  |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `support_chat_token`       | `support-service.ts` (потік LLM)         | `{ token }`                                                 | немає                                                                             |
| `support_chat_complete`    | `support-service.ts`                     | `{ content, screenshots }`                                  | немає                                                                             |
| `support_chat_error`       | `support-service.ts`                     | `{ message }`                                               | немає                                                                             |
| `admin_user_online_upsert` | `ws-presence-service.ts` (канал `admin`) | `{ id, name, email, appType, userAgent, connectionsCount }` | `WSAdminUserOnlineUpsertPayloadSchema` (`schemas/ws/`), бекенд її не використовує |
| `admin_user_online_remove` | `ws-presence-service.ts` (канал `admin`) | `{ id }`                                                    | немає                                                                             |

Шляхи відправки (`broadcast-service.ts`): `broadcastMessageToUser`, `…ToUserExcept`,
`…ToUserConnection` (серіалізують на кожне з'єднання) і `broadcastMessageToChannel`
(`server.publish`, одна серіалізація на всіх підписників). Усе — через `makeBroadcastJson`.

Фронтенд (`useBroadcastHandler.ts`, `utils/ws-payload-guards.ts`) перевіряє payload **власними
guard'ами** і навмисно не тягне ArkType у бандл: рушій збільшує бандл, а його JIT-проба
(`new Function`) дає порушення CSP (коментар у `ws-payload-guards.ts`). Цю межу фіча зберігає.

Поза обсягом — службові повідомлення `ws-handlers.ts` (`pong`, `service:error`,
`unauthorized`): фіксовані конструкції транспорту з власним конвертом (feat-048).

## 3. Аналіз впливу

### 3.1 Позитивний

- Контракт broadcast-подій в одному місці (`shared`), як для HTTP і прямих WS-відповідей.
- Помилку в payload ловить `tsc` (як feat-050 для маршрутів) і перевірка під час виконання.
- Allow-list закриває витік зайвих полів і в асинхронних повідомленнях.

### 3.2 Мінуси та ризики

- **Вартість на потоці.** `support_chat_token` шлеться на кожен токен LLM — сотні повідомлень на
  відповідь. Payload крихітний (`{ token }`), тож перевірка — мікросекунди; заміряти в T6.
- **Що робити з невалідною подією.** Відповіді «500» немає — клієнт чекає на потік, а не на
  запит. Рішення §4.4: подія не відправляється.

### 3.3 Чого не дає

- Не міняє фронтенд-guard'и на ArkType (бандл, CSP). Натомість — тест паритету guard ↔ схема (§4.5).
- Не перевіряє службові повідомлення транспорту (§2).

## 4. Дизайн

### 4.1 Реєстр подій у `shared`

`packages/shared/src/schemas/ws/broadcast-events.ts`:

```ts
export const BroadcastEventSchemas = {
    support_chat_token: type({ token: 'string' }),
    support_chat_complete: type({ content: 'string', screenshots: 'string[]' }),
    support_chat_error: type({ message: 'string' }),
    admin_user_online_upsert: WSAdminUserOnlineUpsertPayloadSchema, // без '+': 'reject' (§4.3)
    admin_user_online_remove: type({ id: EntityIdSchema }),
} as const
export type BroadcastEventName = keyof typeof BroadcastEventSchemas
export type BroadcastPayload<E extends BroadcastEventName> =
    (typeof BroadcastEventSchemas)[E]['inferIn']
```

Схеми описують JSON (feat-047): без `Date`, `bigint`, морфів; той самий набір охорон
`route-access.spec.ts` проходить і по реєстру.

### 4.2 Типізований `broadcastService`

Методи приймають пару `...message: BroadcastMessage` — union кортежів `[E, BroadcastPayload<E>]` (рев'ю: генерик `E` з union-аргументами розривав зв'язок події й payload).
`tsc` не пропустить неіснуючу подію чи невідповідний payload. Виклики в `support-service.ts`
(`broadcastToConnection`) і `ws-presence-service.ts` типізуються так само.

### 4.3 Перевірка під час виконання

`broadcast-service.ts` один раз на старті будує для кожної події перевірку через
`createResponseCheck(schema, config)` (feat-046) і викликає її **один раз на подію** до
серіалізації — до циклу по з'єднаннях, тож вартість не множиться на кількість адресатів.

Allow-list і `'+': 'reject'`: зараз `WSAdminUserOnlineUpsertPayloadSchema` сама відхиляє зайві
ключі. Для бекенда схема має бути без нього — реакцію на зайві ключі задає режим
(`strict` / `log`), як для відповідей. Фронтенд-guard зберігає свою строгість.

`ResponseCheckMeta.transport` — новий варіант `'broadcast'` (тег Sentry `transport`), `route` —
ім'я події.

### 4.4 Невалідна подія

| Результат перевірки           | Дія                                                      |
| ----------------------------- | -------------------------------------------------------- |
| `ok`                          | відправити `payload` з результату (вихідний чи очищений) |
| `ok: false` (будь-який режим) | **не відправляти**, `error` у лог (як для відповідей)    |

Альтернатива — відправити `support_chat_error` замість невалідного токена — відкинута: це
змішує контракт подій і логіку support; клієнт уже має тайм-аут потоку.

### 4.5 Паритет фронтенд-guard'ів

Тест у фронтенді (`utils/__tests__/ws-payload-guards.spec.ts`): для кожної події набір фікстур
(валідна, зайвий ключ, неправильний тип) проганяється через guard і через схему з реєстру — тест
імпортує ArkType, бандл ні. Розбіжність guard ↔ схема падає в CI. Для подій без guard'а
(`support_chat_*`, `admin_user_online_remove`, перевіряються inline у `useBroadcastHandler.ts`) —
винести inline-перевірки в `ws-payload-guards.ts`, щоб тест їх покривав.

## 5. Кроки

1. **T0** — PR у `main`: цей план + task list; feat-049 → `in_progress`, опис оновити; гілка
   `feat/ws-async-message-validation`.
2. **T1** — реєстр `broadcast-events.ts` (§4.1); `WSAdminUserOnlineUpsertPayloadSchema` без
   `'+': 'reject'` або окрема бекенд-версія (§4.3); охорони `route-access.spec.ts` по реєстру.
3. **T2** — тести перед зміною: типи (`@ts-expect-error` на неіснуючу подію й чужий payload);
   під час виконання — валідна подія відправляється, зайвий ключ (`log` — вирізано, `strict` — не
   відправлено), невідповідність — не відправлено, перевірка одна на `broadcastMessageToUser` з
   кількома з'єднаннями.
4. **T3** — `broadcastService` за §4.2–4.4; `ResponseCheckMeta.transport: 'broadcast'`.
5. **T4** — виклики в `support-service.ts`, `ws-presence-service.ts` під типи.
6. **T5** — фронтенд: inline-перевірки → `ws-payload-guards.ts`; тест паритету (§4.5).
7. **T6** — бенчмарк: перевірка `support_chat_token` і `admin_user_online_upsert` на подію
   (`bench:response` або окремий рядок у скрипті).
8. **T7** — документація: `websocket.md` (broadcast-події, реєстр, що буває з невалідною подією),
   `response-validation.md` (тепер і broadcast), `shared/index.md`; `pnpm docs:build && pnpm docs:verify`.
9. **T8** — Definition of Done: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
   `CI=1 pnpm --filter frontend test:e2e`; ручна перевірка — локальний бекенд, адмінський
   WS-клієнт підписаний на онлайн, другий користувач підключається: `admin_user_online_upsert`
   приходить; тимчасово зайве поле в payload → у `log` клієнт його не бачить, у лозі шлях;
   evidence у `progress.md`; feat-049 → `done`.

## 6. Рішення (2026-10-31, власник прийняв пропозиції)

- **Невалідна подія не відправляється** (§4.4), `error` у лог.
- **`'+': 'reject'` прибрати** з `WSAdminUserOnlineUpsertPayloadSchema`: зайвими ключами на
  бекенді керує режим, строгість фронтенду задають guard і тест паритету.
