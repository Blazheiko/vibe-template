# feat-048: однаковий конверт WS-помилок

> Статус: виконано (feat-048, PR #163, merge `429416a`). Дата: 2026-10-30. Залежить від feat-044.

## 1. Задача

Відповідь на WS-повідомлення (`WsResponseData`) — `{ event, timestamp, status, data, error }`.
Для помилок рівня транспорту (`status: 'error'`, конверт у `error`) поле `data` різне:

- `rate_limited`, `service_unavailable`, `unauthorized` (`ws-handlers.ts`, `ws-rate-limit.ts`) і
  перевірка відповіді (feat-044) — `data: null`;
- `validation_failed`, `not_found` і `internal_error` з `catch` у `ws-api-dispatcher.ts` —
  `data: {}`, бо диспетчер створює відповідь з `data: {}` і на помилці його не скидає.

Документація так і пише: «`data: null` (або `{}`)» (`documentation/backend/websocket.md:144`).

Мета: кожна помилка транспорту має `status: 'error'`, `data: null` і конверт `error`; одне місце
будує конверт; тест не дає повернути `{}`.

## 2. Що показав аналіз

Шляхи помилок у диспетчері (`packages/backend/src/vendor/utils/routing/ws-api-dispatcher.ts`):

| Шлях                                               | `data` зараз           | Рядок                 |
| -------------------------------------------------- | ---------------------- | --------------------- |
| Маршрут не знайдено → `not_found`                  | `{}`                   | 124                   |
| `ValidationError` → `validation_failed`            | `{}`                   | 128                   |
| Виняток handler'а чи middleware → `internal_error` | `{}` або часткові дані | 147                   |
| Перевірка відповіді → `internal_error`             | `null`                 | 111                   |
| Rate limit → `rate_limited`                        | `null`                 | `ws-rate-limit.ts:96` |

`internal_error` з `catch` може навіть віддати те, що handler встиг записати в `responseData.data`
до винятку, — кидок після присвоєння не скидає `data`.

Функція `createWsErrorEnvelope` скопійована тричі: `ws-api-dispatcher.ts:24`,
`ws-handlers.ts:91`, `ws-rate-limit.ts:32`.

Окремо існує **друга конвенція**: помилки контролерів і middleware (`appErrorToWsError` у
`controllers/ws/*`, `ws-admin-guard.ts`) ідуть у `data` як `{ status: 'error', code, message }`
зі `status` відповіді `'200'` або `'403'` і `error: null`. Це бізнес-помилки, і їх описує
`ResponseSchema` маршруту (union з `CanonicalErrorResponseSchema`), як і в HTTP. Їх ця фіча не
змінює (§3.3).

Фронтенд (`utils/ws-api-response.ts`, `response-normalizer.ts`) визначає помилку за `error` і
`status` і `data` на помилці не читає — `null` замість `{}` його не зачіпає.

## 3. Аналіз впливу

### 3.1 Позитивний

- Одна форма помилки транспорту: клієнт може покладатися на `data === null`.
- `internal_error` більше не може віддати часткові дані handler'а, що кинув виняток.
- Один модуль для конверта замість трьох копій.

### 3.2 Мінуси та ризики

- Клієнт, що читав `data` на помилці як об'єкт (`data.x`), отримає `null`. У фронтенді шаблону
  таких місць немає (§2); для сторонніх клієнтів — запис у документації.
- Початкове значення `data` змінюється з `{}` на `null` (§4.2): якщо middleware зупинило запит і
  нічого не записало в `data`, клієнт отримає `null` замість `{}`. Middleware шаблону завжди
  пишуть `data` (`ws-admin-guard.ts`).

### 3.3 Чого не дає

- Не переносить бізнес-помилки контролерів і middleware з `data` в `error` — це інша, свідома
  конвенція (помилка — частина контракту маршруту), і зміна контракту для клієнтів. Документація
  має розвести дві конвенції (§4.4).
- Не змінює коди й тексти помилок.

## 4. Дизайн

### 4.1 Один модуль конверта

`vendor/utils/network/ws-error-envelope.ts`:

```ts
export const createWsErrorEnvelope = (code, message, options?) => WsErrorEnvelope
/** Turns a response into a transport error: status 'error', data null, the envelope. */
export const setWsError = (responseData: WsResponseData, envelope: WsErrorEnvelope): void
```

Три копії `createWsErrorEnvelope` замінюються імпортом. Усі помилки транспорту в диспетчері
ставляться через `setWsError`, тож `data: null` не можна забути.

### 4.2 Початкове значення

Диспетчер створює відповідь з `data: null`, а не `{}`. Успішна відповідь однаково перезаписує
`data` результатом handler'а; `{}` лишався лише на шляхах помилок і зупинки middleware.

### 4.3 Охорона

Тест у `ws-validation.spec.ts` (або новий `ws-error-envelope.spec.ts`): для кожного шляху помилки
диспетчера — `not_found` (зокрема `event` з порожнім іменем маршруту), `validation_failed`, виняток
handler'а (зокрема після запису в `responseData.data`), перевірка відповіді, rate limit — відповідь має
`status: 'error'`, `data: null`, `error.code` очікуваний.

### 4.4 Документація

`documentation/backend/websocket.md`:

- «`data: null` (або `{}`)» → «`data: null`»;
- розвести дві конвенції: помилка транспорту — `status: 'error'`, `data: null`, конверт в
  `error`; бізнес-помилка контролера чи middleware — у `data` як канонічна помилка (описана в
  `ResponseSchema`), `error: null`.

## 5. Кроки

1. **T0** — PR у `main`: цей план + task list; feat-048 → `in_progress`, опис оновити (обидва
   виправлення: `data: null` і один модуль конверта; бізнес-помилки поза обсягом); гілка
   `feat/ws-error-envelope`.
2. **T1** — тести перед зміною (§4.3): червоні на `not_found`, `validation_failed`, винятку
   handler'а й `event` з порожнім іменем маршруту.
3. **T2** — `ws-error-envelope.ts` (§4.1); три копії замінити імпортом.
4. **T3** — диспетчер: `setWsError` на всіх шляхах помилок, початкове `data: null` (§4.2);
   оновити фікстури тестів, що будують `responseData` з `data: {}`
   (`ws-admin-guard.spec.ts` тощо).
5. **T4** — документація (§4.4); `pnpm docs:build && pnpm docs:verify`.
6. **T5** — Definition of Done: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
   `CI=1 pnpm --filter frontend test:e2e`; ручна перевірка — локальний бекенд, WS-повідомлення на
   неіснуючий маршрут і з невалідним payload: `data: null`; evidence у `progress.md`; feat-048 →
   `done`.

## 6. Відкриті питання

- **Бізнес-помилки в `data` зі `status: '403'` / `'200'`** — уніфікувати з HTTP-підходом
  (`status` = код помилки) або перенести в `error`? Пропозиція: не в цій фічі; якщо потрібно —
  окремий запис у `feature_list.json`, бо це зміна контракту WS-маршрутів.
