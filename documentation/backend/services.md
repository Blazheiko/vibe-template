# Сервіси

Сервіс — це **серце застосунку**: тут живуть бізнес-правила, перевірка прав і власності ресурсів, оркестрація кількох репозиторіїв і зовнішніх інтеграцій (email, push, LLM, Sentry, Redis). Сервіс не знає, звідки прийшов виклик — з HTTP-контролера, WS-обробника чи фонового скрипта, — і повертає результат як значення `AppResult<T>`, а не як HTTP-відповідь.

## Навіщо потрібен цей шар

- **Бізнес-логіка в одному місці.** Правило «користувач може видалити лише свою push-підписку» або «після N невдалих спроб — `429`» описане один раз у сервісі й однаково працює для всіх точок входу.
- **Незалежність від транспорту.** Сервіс не має доступу до `responseData`, cookies і сокетів. Його можна викликати з будь-якого контролера, з іншого сервісу чи з тесту без підняття сервера.
- **Явні очікувані помилки в типах.** Те, що клієнт має розрізняти (`NotFound`, `Conflict`, `RateLimited`, невірний пароль), сервіс повертає як `Result.err(AppError)`. TypeScript не дасть контролеру забути обробити таку помилку, а тег однозначно визначає HTTP-статус.
- **Збої інфраструктури кидаються** ([ADR 0004](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0004-result-for-expected-outcomes.md)). Виклик репозиторію, Redis чи S3 не обгортається: виняток доходить до транспорту, і `classifyError` дає 500 `internal_error` (або 503 для Redis) з логом і подією в Sentry. Cookie сесії, яку запит уже виставив (наприклад, після логіну), іде у відповідь; інші cookies обробника відкидаються.
- **Головне місце для тестів.** Оскільки вся логіка тут, а залежності — звичайні ES-імпорти, сервіс тестується з моками репозиторіїв і трансформерів, без БД.

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

## Структура

Сервіси лежать у [`src/app/services`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/services). Index-файлів у доменах немає — імпорт іде з конкретного файлу.

| Домен            | Відповідальність                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `actions/`       | Лише типи `ToolDefinition` / `ToolCallHandler` для викликів інструментів                 |
| `admin/`         | Онлайн-користувачі, історія онлайну, підписка адміна на WS-канал                         |
| `ai/`            | Адаптери LLM-провайдерів (OpenAI, Mistral, xAI), промпти, облік використання (`usage/`)  |
| `auth/`          | Реєстрація/логін, OAuth, скидання пароля, верифікація email/SMS, throttle, WS-токен      |
| `communication/` | Broadcast, присутність у WS, онлайн-статус, URL WebSocket                                |
| `core/`          | `mainService`: init, сесія, оновлення WS-токена                                          |
| `notifications/` | Email, push-підписки та відправка push                                                   |
| `observability/` | Інтеграція із Sentry                                                                     |
| `shared/`        | `AppError`/`AppResult`, логування 5xx (`reportAppError`), мапінг помилок у HTTP/WS, мова |
| `statistics/`    | Статистика push-підписок                                                                 |
| `support/`       | Чат підтримки, база знань, ембединги, LLM, переклад запитів                              |
| `user/`          | Аватар                                                                                   |

## Як сервіси оголошуються

DI-контейнера немає. Сервіс — модульний синглтон-об'єкт (`export const authService = { ... }`, [auth-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-service.ts)) або окрема функція (`export async function consumeAuthThrottle`, [auth-throttle-service.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/auth-throttle-service.ts)). Залежності — звичайні ES-імпорти репозиторіїв і трансформерів з `#app/repositories/index.js` і `#app/transformers/index.js` (див. [Репозиторії](/backend/repositories)). Фабрика використовується лише для AI-адаптера: `export const textAdapter = createTextAdapter()` у [ai-provider.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/ai/ai-provider.ts).

## Результати та помилки

Сервіси повертають `AppResult<T> = Result<T, AppError>` з `better-result` для очікуваних результатів, а збої інфраструктури кидають. `AppError` — дискримінований union за `_tag` ([errors.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts)); конструктори: `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `rateLimited`, `internal`. Виклики репозиторіїв не обгортаються ([ADR 0004](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0004-result-for-expected-outcomes.md)); best-effort крок (видалити старий файл з S3) ловить виняток локально і пише `warn`. Приклад — [Крок 6](/backend/adding-a-feature#крок-6-service).

Бізнес-правила (перевірка власника ресурсу, throttle, генерація токенів, повідомлення) живуть у сервісах.

## Тести сервісів

Тести `*.spec.ts` лежать поруч із сервісом. Патерн: замокати `#app/repositories/index.js` і `#app/transformers/index.js` через `vi.mock`, імпортувати сервіс динамічно після моків, перевіряти `Result.isOk` / `Result.isError` для очікуваних результатів і `rejects` для збою репозиторію. Фрагмент з [push-subscription-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/push-subscription-service.spec.ts):

```ts
vi.mock('#app/repositories/index.js', () => ({
    pushSubscriptionRepository: pushSubscriptionRepositoryMock,
}))

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

it('returns serialized subscriptions', async () => {
    pushSubscriptionRepositoryMock.findByUserIdWithLogs.mockResolvedValue([{ id: 1n }])

    const { pushSubscriptionService } = await import('./push-subscription-service.js')
    const result = await pushSubscriptionService.getSubscriptions(7n)

    expect(Result.isOk(result)).toBe(true)
})
```

## Потік виклику

```mermaid
flowchart LR
    R[Router + middleware] --> C[Controller]
    C -->|getTypedPayload, auth.getUserId| S[Service]
    S --> Repo[Repository]
    Repo --> DB[(PostgreSQL)]
    S --> T[Transformer]
    S -->|Result.ok| C
    S -->|Result.err AppError| E[mapControllerError]
    E -->|status + error payload| C
    C --> Resp[HTTP response]
    Repo -.->|виняток| H[handleError / classifyError]
    H --> Resp
```

## Чек-лист сервісу

- [ ] бізнес-правила, перевірка прав і власності;
- [ ] виклики репозиторіїв (без обгортки, збій кидається) і серіалізація через трансформери;
- [ ] зовнішні інтеграції (email, push, LLM, Sentry);
- [ ] `AppResult<T>` для очікуваних результатів, без доступу до `responseData`.

## Суміжні шари

- [Контролери](/backend/controllers) — HTTP/WS-адаптери: приймають запит і віддають відповідь.
- [Сервіси](/backend/services) — бізнес-логіка, повертають `AppResult<T>`.
- [Репозиторії](/backend/repositories) — єдине місце, де пишеться SQL.
- [Трансформери](/backend/transformers) — перетворення рядків БД на публічні DTO.

Загальна схема — [Архітектура](/backend/architecture), покроковий приклад — [Додавання фічі](/backend/adding-a-feature).
