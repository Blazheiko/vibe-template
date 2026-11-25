# Трансформери

Трансформер — це **чиста функція серіалізації**: вона бере рядок, який повернув репозиторій (з `bigint` id, об'єктами `Date` і внутрішніми полями), і перетворює його на публічний DTO, який можна безпечно віддати клієнту в JSON.

## Навіщо потрібен цей шар

- **Безпека даних.** Рядок `users` містить хеш пароля і `sessionToken`. Трансформер явно відкидає такі поля, тож вони не потраплять у відповідь навіть якщо сервіс поверне «весь користувач». Без цього шару легко випадково віддати клієнту зайве.
- **JSON-сумісність.** `bigint` не серіалізується `JSON.stringify`, а `Date` треба віддавати в єдиному форматі. Трансформер приводить id до `string`, а дати — до ISO-рядка UTC (`toISOString()`). Схема відповіді описує вже цей формат — див. [Перевірка відповідей](/backend/response-validation#як-перевіряється-відповідь).
- **Стабільний публічний контракт.** Внутрішні назви колонок (`createdAt`) можуть змінюватися, а клієнт очікує `created_at`. Трансформер — одне місце, де визначається, як сутність виглядає зовні; похідні поля (`emailVerified: boolean` замість `emailVerifiedAt`) теж додаються тут.
- **Повторне використання.** Один і той самий користувач повертається з логіну, реєстрації, OAuth — усі вони викликають `userTransformer.serialize`, тож форма відповіді однакова.
- **Легко тестувати.** Трансформер не має залежностей і побічних ефектів: вхідний рядок → вихідний об'єкт.

```mermaid
flowchart LR
    R[Router + middleware] --> C[Controller]
    C --> S[Service]
    S --> Repo[Repository]
    Repo --> DB[(PostgreSQL)]
    S --> T[Transformer]
    T --> DTO[DTO]
    S -->|AppResult| C
    C --> Resp[HTTP / WS response]
```

## Як влаштовані

Трансформери в [`app/transformers/`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/index.ts) — це об'єкти з методами `serialize` / `serializeArray` (у push-підписок ще `serializeWithLogs` / `serializeArrayWithLogs`, у логів push — `serializeSummary`). Є `userTransformer`, `pushSubscriptionTransformer`, `pushNotificationLogTransformer` і `promptTransformer`. Вони:

- приводять id до `string` через `toEntityId` з [`app/domain/ids.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/domain/ids.ts) (брендований id стає рядком на дроті, ADR 0007);
- переводять `Date` у ISO-рядок UTC через `toISOString()` (формат `2026-10-25T10:00:00.000Z` не залежить від часового поясу процесу); `userTransformer` і `pushSubscriptionTransformer` ще перейменовують `createdAt`/`updatedAt` → `created_at`/`updated_at`;
- прибирають чутливі поля: [user-transformer.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/user-transformer.ts) відкидає `password` і `sessionToken` (простір імен сесій у Redis, див. [Автентифікація](/backend/auth#що-таке-usertoken)) і додає похідне `emailVerified: boolean`.

```ts
serialize(user: UserRow): SerializedUser {
    const { id, password: _password, sessionToken: _sessionToken, createdAt, updatedAt, emailVerifiedAt, ...rest } = user
    return { ...rest, id: String(id), created_at: createdAt.toISOString(), /* ... */ }
}
```

Тип результату (`SerializedUser`, `SerializedPushSubscription`) виводиться з типу рядка через `Omit<...> & {...}`, тож він живе в бекенді й **не імпортується** з `packages/shared`. Схеми відповідей у [packages/shared/src/responses](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/main-controller.ts) описані окремо (ArkType). Відповідність DTO і схеми перевіряє компілятор — `defineRoute` звіряє результат контролера зі схемою ([Тип відповіді хендлера](/backend/routing#тип-відповіді-хендлера)) — і перевірка відповіді під час виконання ([Перевірка відповідей](/backend/response-validation)).

## Де використовуються

Трансформери викликаються в **сервісах**: `userTransformer` — у [auth-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-service.ts); `pushSubscriptionTransformer` — у [push-subscription-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/push-subscription-service.ts) і [push-subscription-statistics-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/statistics/push-subscription-statistics-service.ts).

`pushNotificationLogTransformer` — у `push-subscription-service.ts` і всередині `pushSubscriptionTransformer.serializeWithLogs`; `promptTransformer` — у [prompt-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/ai/prompt-controller.ts) (сервіс prompts кешує рядки БД).

Обхід: `mainService.init` збирає об'єкт користувача вручну (див. [«Архітектура»](/backend/architecture)); адмінські списки, knowledge base, support- та online-історія серіалізують рядки у своїх сервісах без окремого трансформера.

## Тестування

Трансформери — чисті функції, тож їх тестують без моків: [user-transformer.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/user-transformer.spec.ts) перевіряє, що `password` і `sessionToken` не потрапляють у DTO. У тестах сервісів трансформери мокають через barrel:

```ts
vi.mock('#app/transformers/index.js', () => ({
    pushSubscriptionTransformer: pushSubscriptionTransformerMock,
}))
```

## Суміжні шари

- [Контролери](/backend/controllers) — HTTP/WS-адаптери: приймають запит і віддають відповідь.
- [Сервіси](/backend/services) — бізнес-логіка, повертають `AppResult<T>`.
- [Репозиторії](/backend/repositories) — єдине місце, де пишеться SQL.
- [Трансформери](/backend/transformers) — перетворення рядків БД на публічні DTO.

Загальна схема — [Архітектура](/backend/architecture), покроковий приклад — [Додавання фічі](/backend/adding-a-feature).
