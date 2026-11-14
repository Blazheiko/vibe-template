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

Компоненты отправляют WS-запросы через контракт: `callWs(contract, payload)` из `@/utils/ws-client`, контракты — из `shared/contracts` (ADR 0006). Прямой вызов `websocketApi` вне `ws-client.ts`, `useWebSocketConnection.ts` и тестов запрещён ESLint (`eslint.config.ts`).

```typescript
import { supportWsContracts, adminWsContracts } from 'shared/contracts'
import { callWs } from '@/utils/ws-client'

// Событие `api/support/support_open_chat`, ответ ждётся 10 с — как в SupportView.vue
const reply = await callWs(supportWsContracts.openChat, { language: supportLanguage() })

// Контракт без payload — как в AdminLayout.vue
await callWs(adminWsContracts.subscribeOnlineUsers)
```

`callWs` резолвится с ответом, включая бизнес-ошибку (`reply.data.status === 'error'`), и отклоняется только при ошибке транспорта (соединение не открыто или сброшено) или по таймауту.

## API

Возвращаемые значения:

| Имя                                               | Что это                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statusWebSocket`                                 | статус VueUse: `'CONNECTING' \| 'OPEN' \| 'CLOSED'`                                                                                                                                                                 |
| `isConnected` / `isConnecting` / `isDisconnected` | computed по `statusWebSocket`                                                                                                                                                                                       |
| `isInitialized`                                   | `true` после открытия соединения / события `connection_established`                                                                                                                                                 |
| `websocketOpen(url, token)`                       | открыть или переоткрыть соединение                                                                                                                                                                                  |
| `websocketClose()`                                | закрыть соединение и отменить ожидающие API-запросы                                                                                                                                                                 |
| `sendMessage(data: SendPayload)`                  | отправить объект как есть (`event` — полный путь, например `api/support/support_open_chat`; у запросов `websocketApi` — `{ event, id, timestamp, payload }`); если соединение не открыто, сообщение не отправляется |
| `websocketApi(route, payload?)`                   | внутренний транспорт `callWs`: запрос с `id`, ответ ищется по нему; отклоняется по таймауту (10 с) или при закрытии соединения. Компоненты используют `callWs`                                                      |

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

| Файл                         | Назначение                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `useBroadcastHandler.ts`     | разбор broadcast-событий WebSocket (см. выше)                                                                  |
| `useLocale.ts`               | язык браузера: начальная локаль и язык ответов Support                                                         |
| `useAdminUserDetailModal.ts` | модалка «детали пользователя» в админке: загрузка по `openUserModal(userId)`, сброс при `closeModal()`         |
| `useAuthRequest.ts`          | обёртка запроса auth-формы: флаг загрузки, «ошибка сервера» при исключении, `failureMessage` для ответа-ошибки |
| `useCompleteSignIn.ts`       | после входа/регистрации: сохранить пользователя, перейти на `?redirect=` (или в аккаунт), затем `init_app`     |
| `useModalDialog.ts`          | клавиатура модального окна: фокус внутрь, Tab в пределах панели, Escape закрывает, возврат фокуса              |
| `useOAuthProviders.ts`       | список OAuth-провайдеров с бэкенда, загружается один раз на страницу                                           |
| `usePwaInstallButton.ts`     | пункт меню «Install App»: системный prompt браузера или диалог `<pwa-install>`                                 |
| `useSessionLifecycle.ts`     | реакция на окончание сессии (`redirectToLogin`)                                                                |
