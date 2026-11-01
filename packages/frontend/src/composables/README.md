# WebSocket Connection Composable

## Описание

`useWebSocketConnection` (`useWebSocketConnection.ts`) — singleton composable для единственного WebSocket-соединения приложения. Аргументов не принимает: состояние и обработчики создаются один раз при загрузке модуля.

## Singleton через модульную систему JS

Код модуля выполняется один раз — при первом импорте. Всё, что объявлено на уровне модуля (`wsUrl`, `status`, `apiResolve`, экземпляр `useWebSocket` из VueUse), существует в одном экземпляре, а `useWebSocketConnection()` лишь возвращает ссылки на него. Поэтому любой компонент, вызвавший composable, видит то же соединение и те же реактивные значения, и ручной `if (!instance)` не нужен.

```
useWebSocketConnection.ts  (загружается один раз)
  const status = …, const wsUrl = …, useWebSocket(…)
  export const useWebSocketConnection = () => ({ statusWebSocket: status, … })
        ▲                                   ▲
   App.vue: websocketOpen(url, token)   любой компонент: isConnected, sendMessage
```

Следствие: при HMR в dev-режиме модуль может перезагрузиться, и состояние сбросится.

## Использование

### Открытие соединения (App.vue)

Соединение открывает только `App.vue` после `main/init`, передавая URL и WS-токен с бэкенда:

```typescript
const { websocketClose, websocketOpen } = useWebSocketConnection()

// data — ответ main/init
websocketOpen(data.wsUrl as string, data.wsToken as string)
```

Токен уходит первым значением `Sec-WebSocket-Protocol`, вторым — тип приложения (`app-web` / `app-pwa`). Повторный вызов с тем же URL (например, после обновления токена) переоткрывает соединение.

### В любом компоненте

```typescript
const { isConnected, websocketApi } = useWebSocketConnection()

// Запрос-ответ через WebSocket: отправляется событие `api/<route>`
// (здесь `api/support/support_open_chat`), ответ ждётся 10 с — как в SupportView.vue
if (isConnected.value) {
    const response = await websocketApi('support/support_open_chat', {})
}

// sendMessage отправляет событие как есть: для WS-маршрута нужен полный путь
// `api/<group>/<route>`, иначе диспетчер его не найдёт
```

## API

Возвращаемые значения:

| Имя                                               | Что это                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statusWebSocket`                                 | статус VueUse: `'CONNECTING' \| 'OPEN' \| 'CLOSED'`                                                                                                                         |
| `isConnected` / `isConnecting` / `isDisconnected` | computed по `statusWebSocket`                                                                                                                                               |
| `isInitialized`                                   | `true` после открытия соединения / события `connection_established`                                                                                                         |
| `websocketOpen(url, token)`                       | открыть или переоткрыть соединение                                                                                                                                          |
| `websocketClose()`                                | закрыть соединение и отменить ожидающие API-запросы                                                                                                                         |
| `sendMessage(data: SendPayload)`                  | отправить `{ event, timestamp, payload }` как есть (`event` — полный путь, например `api/support/support_open_chat`); если соединение не открыто, сообщение не отправляется |
| `websocketApi(route, payload?)`                   | API-запрос через WebSocket; Promise, отклоняется по таймауту (10 с) или при закрытии соединения                                                                             |
| `ws`                                              | сырой `WebSocket` (для отладки)                                                                                                                                             |

## Поведение соединения

- **Heartbeat:** `ping` каждые 10 с, ожидание `pong` — 5 с (`utils/websocket-heartbeat.ts`).
- **Закрытие с кодом 4001** (истёк токен): запрашивается новый токен (`mainApi.updateWsToken`) и соединение переоткрывается; если бэкенд отвечает «не авторизован» — событие `unauthorized` в `eventBus` и закрытие; при другой ошибке — повтор через 5 с.
- **Коды 4000–4099** (кроме 4001): переподключение запрещено, соединение закрывается.
- **Другие коды:** переподключение через 5 с. Встроенный `autoReconnect` VueUse не используется.
- При любом закрытии ожидающие `websocketApi`-запросы отклоняются.

## Broadcast-события

Входящие broadcast-сообщения разбирает `useBroadcastHandler.ts`, проверяет форму payload и пересылает в `eventBus`:

- `support_chat_token`, `support_chat_complete`, `support_chat_error` — потоковый ответ Support AI;
- `admin_user_online_upsert`, `admin_user_online_remove` — онлайн-статус пользователей в админке.

Служебные события (`connection_established`, `connection_closed`, `pong`) обрабатываются внутри composable.

## Остальные composables

| Файл                     | Назначение                                      |
| ------------------------ | ----------------------------------------------- |
| `useBroadcastHandler.ts` | разбор broadcast-событий WebSocket (см. выше)   |
| `useLocale.ts`           | текущая локаль и переключение языка             |
| `useSessionLifecycle.ts` | реакция на окончание сессии (`redirectToLogin`) |
| `useToast.ts`            | уведомления                                     |
