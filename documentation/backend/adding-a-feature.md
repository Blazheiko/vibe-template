# Як додати фічу в бекенд

Цей туторіал крок за кроком додає новий ресурс **`notes`** (нотатки поточного користувача) з двома ендпоінтами, `GET /api/notes` і `POST /api/notes`, і проходить усі шари архітектури проєкту: shared-схеми → Drizzle-таблиця й міграція → repository → transformer → service → controller → контракт і реєстрація маршруту → unit-тест на Vitest.

::: info Перед читанням
Пройдіть вправу [Перший маршрут](/guide/first-endpoint): там ті самі шари (схема → service → controller → route) показано без бази даних. Цей туторіал додає до них таблицю, міграцію, repository, transformer і захист маршруту сесією.
:::

::: tip Скіл для агента
Claude Code може пройти ці кроки сам: у репозиторії є скіл [`backend-feature`](https://github.com/Blazheiko/vibe-template/blob/main/.claude/skills/backend-feature/SKILL.md) (`.claude/skills/backend-feature/`). Джерело правди — ця сторінка: якщо скіл і туторіал розходяться, правильний туторіал. Агенти без підтримки скілів читають цю сторінку напряму.
:::

Загальну картину шарів описано в [Архітектурі](/backend/architecture), роутинг і middleware — у [Маршрутизації](/backend/routing) і [Middleware](/backend/middlewares), роботу з БД — у [Базі даних](/backend/database), а шлях запиту — у [Життєвому циклі запиту](/backend/request-lifecycle).

::: tip Перевірено на практиці
Весь код нижче було реально додано в чисту копію репозиторію, після чого пройшли `pnpm --filter shared build`, `pnpm typecheck`, повний `pnpm --filter backend test` (разом із новим `note-service.spec.ts` і перевіркою шарів `layering.spec.ts`) та `npx eslint` для змінених файлів, а запити з кроку 10 виконано на запущеному сервері. Як зразок узято наявну фічу push-підписок.
:::

## Що буде створено

| Шар                  | Файл                                                                | Дія         |
| -------------------- | ------------------------------------------------------------------- | ----------- |
| Shared: вхід         | `packages/shared/src/schemas/note/create-note.ts`                   | новий       |
| Shared: вхід         | `packages/shared/src/schemas/index.ts`                              | редагування |
| Shared: відповіді    | `packages/shared/src/responses/note-controller.ts`                  | новий       |
| Shared: відповіді    | `packages/shared/src/responses/index.ts`                            | редагування |
| Таблиця              | `packages/backend/src/database/schema.ts`                           | редагування |
| Міграція             | `packages/backend/src/drizzle/migrations/<timestamp>_add_notes/`    | генерується |
| Repository           | `packages/backend/src/app/repositories/note/note-repository.ts`     | новий       |
| Repository (barrel)  | `packages/backend/src/app/repositories/index.ts`                    | редагування |
| Transformer          | `packages/backend/src/app/transformers/note-transformer.ts`         | новий       |
| Transformer (barrel) | `packages/backend/src/app/transformers/index.ts`                    | редагування |
| Service              | `packages/backend/src/app/services/note/note-service.ts`            | новий       |
| Controller           | `packages/backend/src/app/controllers/http/note/note-controller.ts` | новий       |
| Shared: контракт     | `packages/shared/src/contracts/notes.ts`                            | новий       |
| Shared: контракт     | `packages/shared/src/contracts/index.ts`                            | редагування |
| Реєстр схем          | `packages/backend/src/app/routes/contract-schemas/notes.ts`         | новий       |
| Реєстр схем          | `packages/backend/src/app/routes/contract-schemas/index.ts`         | редагування |
| Маршрути             | `packages/backend/src/app/routes/http-routes.ts`                    | редагування |
| Виклик з фронтенду   | `packages/frontend/src/utils/api.ts`                                | редагування |
| Тест                 | `packages/backend/src/app/services/note/note-service.spec.ts`       | новий       |

## Крок 1. Схема вхідних даних у `shared`

Вхідні payload-и описуються ArkType-схемами в `packages/shared/src/schemas/<домен>/`. Ключ `"+": "reject"` забороняє зайві поля, так само як у [create-subscription.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/push-subscription/create-subscription.ts).

```ts
// packages/shared/src/schemas/note/create-note.ts
import { type } from '@arktype/type'

export const CreateNoteInputSchema = type({
    title: '1 <= string <= 200',
    'body?': 'string <= 5000',
    '+': 'reject',
})

export type CreateNoteInput = typeof CreateNoteInputSchema.infer
```

Експортуйте схему й тип з [packages/shared/src/schemas/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/index.ts) (звідти їх імпортують як `shared/schemas`):

```ts
export { CreateNoteInputSchema, type CreateNoteInput } from './note/create-note.js'
```

## Крок 2. Схеми відповідей у `shared`

Відповіді контролерів живуть у `packages/shared/src/responses/` і будуються як `type.or(<успіх>, CanonicalErrorResponseSchema)`, див. [push-subscription-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/push-subscription-controller.ts) та [error-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/error-response.ts). Тип `Note` — це публічний контракт, який повертає transformer. Сервер перевіряє кожну відповідь маршруту за цією схемою в будь-якому середовищі: розбіжність дає `500`, а зайве поле — `500` поза production і вирізається в production (режим `log`) — див. [Перевірка відповідей](/backend/response-validation).

```ts
// packages/shared/src/responses/note-controller.ts
import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

export const NoteSchema = type({
    id: 'string',
    title: 'string',
    body: 'string | null',
    created_at: 'string | null',
})
export type Note = typeof NoteSchema.infer

export const GetNotesResponseSchema = type.or(
    { status: "'success'", notes: NoteSchema.array() },
    CanonicalErrorResponseSchema,
)
export type GetNotesResponse = typeof GetNotesResponseSchema.infer

export const CreateNoteResponseSchema = type.or(
    { status: "'success'", note: NoteSchema },
    CanonicalErrorResponseSchema,
)
export type CreateNoteResponse = typeof CreateNoteResponseSchema.infer
```

Додайте рядок у [packages/shared/src/responses/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/index.ts):

```ts
export * from './note-controller.js'
```

Бекенд споживає `shared` через `dist/` (див. `exports` у [packages/shared/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/package.json)), тому після змін **обов'язково** перезберіть пакет. Лише dev-сервер (`pnpm dev`) читає `src/` через умову `shared-source` і бачить зміни без збірки:

```bash
pnpm --filter shared build
```

## Крок 3. Таблиця й міграція

Додайте таблицю в кінець [packages/backend/src/database/schema.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts). Усі потрібні хелпери (`pgTable`, `bigserial`, `bigint`, `varchar`, `text`, `timestamp`, `index`) там уже імпортовано, а `users` оголошено вище у файлі.

```ts
export const notes = pgTable(
    'notes',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        title: varchar('title', { length: 200 }).notNull(),
        body: text('body'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [index('notes_user_id_idx').on(table.userId)],
)
```

::: warning Часовий пояс
Колонка `timestamp` без часового поясу: Drizzle пише й читає JS `Date` як UTC, а `now()` береться в часовому поясі сесії PostgreSQL. Тому всі з'єднання застосунку й `db:seed` відкриваються з `TimeZone=UTC` ([`pool-options.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/pool-options.ts)), і `created_at` не зсувається, навіть якщо сервер PostgreSQL налаштований на інший пояс. Прямий SQL-клієнт (psql тощо) бачить значення в UTC лише якщо сам встановить `SET TimeZone = 'UTC'`.
:::

Згенеруйте міграцію ([drizzle.config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/drizzle.config.ts) пише їх у `src/drizzle/migrations` у форматі «тека на міграцію»):

```bash
pnpm --filter backend db:generate --name add_notes
```

`drizzle-kit generate` порівнює схему з попередніми знімками й **не потребує запущеної БД**. Результат — `src/drizzle/migrations/<timestamp>_add_notes/migration.sql`:

```sql
CREATE TABLE "notes" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notes_user_id_idx" ON "notes" ("user_id");--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
```

Щоб застосувати міграцію до живої БД, виконайте `pnpm --filter backend db:migrate` (потрібен PostgreSQL з налаштуваннями `PGSQL_*`). У цьому прикладі зв'язок іде лише через `userId`, тому [relations.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/relations.ts) не змінюємо.

## Крок 4. Repository

Repository — єдине місце, де виконуються запити Drizzle. Патерн узято з [push-subscription-repository.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/notifications/push-subscription-repository.ts): типи рядків через `InferSelectModel` / `InferInsertModel`, інтерфейс `I...Repository` і об'єкт-реалізація.

```ts
// packages/backend/src/app/repositories/note/note-repository.ts
import { db } from '#database/db.js'
import { notes } from '#database/schema.js'
import { desc, eq } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

export type NoteRow = InferSelectModel<typeof notes>
export type NoteInsert = InferInsertModel<typeof notes>

export interface INoteRepository {
    create(data: NoteInsert): Promise<NoteRow>
    findByUserId(userId: bigint): Promise<NoteRow[]>
}

export const noteRepository: INoteRepository = {
    async create(data) {
        const [created] = await db.insert(notes).values(data).returning()
        if (created === undefined) {
            throw new Error('Failed to create note')
        }
        return created
    },

    async findByUserId(userId) {
        return await db
            .select()
            .from(notes)
            .where(eq(notes.userId, userId))
            .orderBy(desc(notes.createdAt))
    },
}
```

Додайте експорт у barrel [repositories/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/index.ts). Сервіси імпортують repository саме звідти, і саме цей модуль мокається в тестах:

```ts
export { noteRepository } from './note/note-repository.js'
export type { NoteRow, NoteInsert } from './note/note-repository.js'
```

## Крок 5. Transformer

Transformer перетворює рядок БД на публічний DTO: `bigint` → `string`, `Date` → ISO-рядок UTC через `toISOString()`, як у [push-subscription-transformer.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/push-subscription-transformer.ts). Внутрішні поля (`userId`) назовні не віддаються.

```ts
// packages/backend/src/app/transformers/note-transformer.ts
import type { Note } from 'shared'
import type { NoteRow } from '#app/repositories/index.js'

export const noteTransformer = {
    serialize(note: NoteRow): Note {
        return {
            id: String(note.id),
            title: note.title,
            body: note.body,
            created_at: note.createdAt.toISOString(),
        }
    },

    serializeArray(notes: NoteRow[]): Note[] {
        return notes.map((n) => noteTransformer.serialize(n))
    },
}
```

Тип `NoteRow` імпортується з barrel `#app/repositories/index.js`, а не з файлу репозиторію: прямий імпорт поза `app/repositories` заборонено, і [`layering.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/layering.spec.ts) на ньому впаде.

Експорт у [transformers/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/index.ts):

```ts
export { noteTransformer } from './note-transformer.js'
```

## Крок 6. Service

Сервіс містить бізнес-логіку. Очікувані результати (не знайдено, конфлікт, ліміт) він повертає як `AppResult<T>` (`Result` з `better-result`, див. [errors.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts)). Виклики repository не обгортаються: збій БД кидається, і транспорт відповідає 500 з логом і подією в Sentry ([ADR 0004](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0004-result-for-expected-outcomes.md)).

```ts
// packages/backend/src/app/services/note/note-service.ts
import type { CreateNoteInput } from 'shared/schemas'
import type { Note } from 'shared'
import { Result } from 'better-result'
import { noteRepository } from '#app/repositories/index.js'
import { noteTransformer } from '#app/transformers/index.js'
import type { AppResult } from '#app/services/shared/errors.js'

export const noteService = {
    async getNotes(userId: bigint): Promise<AppResult<{ notes: Note[] }>> {
        const rows = await noteRepository.findByUserId(userId)
        return Result.ok({ notes: noteTransformer.serializeArray(rows) })
    },

    async createNote(userId: bigint, payload: CreateNoteInput): Promise<AppResult<{ note: Note }>> {
        const created = await noteRepository.create({
            userId,
            title: payload.title,
            body: payload.body ?? null,
        })
        return Result.ok({ note: noteTransformer.serialize(created) })
    },
}
```

## Крок 7. Controller

Контролер — тонкий шар. Він дістає `userId` з `context.auth`, бере вже провалідований payload через `getTypedPayload`, викликає сервіс і повертає `respond(context, result, toBody)`: помилка стає канонічною відповіддю з правильним HTTP-статусом (`mapControllerError`), значення — тілом через `toBody`. Усі поля `context` (`httpData`, `responseData`, `session`, `auth`, `logger`) описані в [HttpContext докладно](/backend/controllers#httpcontext-докладно). Структуру взято з [push-subscription-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/notifications/push-subscription-controller.ts).

```ts
// packages/backend/src/app/controllers/http/note/note-controller.ts
import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { noteService } from '#app/services/note/note-service.js'
import { unauthorized } from '#app/services/shared/errors.js'
import type { CreateNoteResponse, GetNotesResponse } from 'shared'
import type { CreateNoteInput } from 'shared/schemas'

export default {
    async getNotes(context: HttpContext): Promise<GetNotesResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await noteService.getNotes(userId)
        return respond(context, result, (value) => ({ status: 'success', notes: value.notes }))
    },

    async createNote(context: HttpContext<CreateNoteInput>): Promise<CreateNoteResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await noteService.createNote(userId, payload)
        return respond(context, result, (value) => ({ status: 'success', note: value.note }))
    },
}
```

Автентифікацію гарантує middleware `auth_guard` на групі маршрутів (наступний крок). Перевірка `userId === null` — лише захисна гілка для типізації.

Якщо дії нема чого повертати (наприклад, видалення), handler повертає `null`: відповідь буде `204 No Content` без тіла, а явно заданий 201 чи 202 збережеться. Деталі — [Відповідь без даних](/backend/request-lifecycle#відповідь-без-даних).

## Крок 8. Контракт і реєстрація маршрутів

Кожен HTTP-маршрут застосунку оголошено через контракт ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md), [Маршрутизація](/backend/routing#http-маршрути-defineroute)). Хелпер маршруту без контракту (`defineRawRoute`) у коді застосунку забороняє ESLint, а маршрут без контракту чи без запису в реєстрі не пройде тест [`route-contracts.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-contracts.spec.ts). Для нотаток потрібні три частини: контракт у `shared`, запис у реєстрі схем і самі маршрути.

**Контракт.** Він описує метод, повний шлях під API-префіксом і типи тіла, query й відповіді. Схеми імпортуються лише як типи (`import type`), тож у браузерний бандл вони не потрапляють. Зразок — [push-subscriptions.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/push-subscriptions.ts):

```ts
// packages/shared/src/contracts/notes.ts
import type { CreateNoteInputSchema } from '../schemas/note/create-note.js'
import type { CreateNoteResponse, GetNotesResponse } from '../responses/note-controller.js'
import { contract } from './core.js'

export const noteContracts = {
    list: contract<undefined, undefined, GetNotesResponse>()('get', '/notes'),
    create: contract<typeof CreateNoteInputSchema.inferIn, undefined, CreateNoteResponse>()(
        'post',
        '/notes',
    ),
} as const
```

Експортуйте групу з [packages/shared/src/contracts/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/index.ts) (звідти її імпортують як `shared/contracts`) і знову перезберіть `shared`:

```ts
export { noteContracts } from './notes.js'
```

**Реєстр схем.** Схеми маршрутів живуть у бекенді, по файлу на групу контрактів. [`contractSchemas`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) вимагає запис для кожного контракту групи і звіряє його з типами контракту: якщо вхід `CreateNoteInputSchema` розійдеться з типом тіла контракту або забудете запис для `list`, впаде `pnpm typecheck`.

```ts
// packages/backend/src/app/routes/contract-schemas/notes.ts
import { CreateNoteInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { noteContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const noteSchemas = contractSchemas(noteContracts, {
    list: { response: ResponseSchemas.GetNotesResponseSchema },
    create: {
        body: CreateNoteInputSchema,
        response: ResponseSchemas.CreateNoteResponseSchema,
    },
})
```

Додайте групу до `mergeContractSchemas(...)` у [contract-schemas/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts):

```ts
import { noteSchemas } from './notes.js'
// ...
export const contractSchemaRegistry = mergeContractSchemas(
    adminSchemas,
    // ...
    supportWsSchemas,
    noteSchemas,
)
```

`mergeContractSchemas` ([contract-registry.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts)) на відміну від spread не дає пізнішій групі тихо перезаписати запис попередньої: два контракти з однаковим `<method> <path>` зупиняють імпорт модуля, тож не стартують ні сервер, ні тести.

**Маршрути.** У [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) `defineRoute` уже імпортовано з `#app/routes/contract-schemas/index.js`. Додайте імпорт контролера (поруч з іншими) і допишіть `noteContracts` до наявного імпорту з `shared/contracts`:

```ts
import NoteController from '#app/controllers/http/note/note-controller.js'
// ...
import {
    // ...
    supportContracts,
    noteContracts,
} from 'shared/contracts'
```

Потім додайте групу останнім елементом масиву, перед `] satisfies routeList`:

```ts
    {
        group: [
            defineRoute({
                contract: noteContracts.list,
                handler: NoteController.getNotes.bind(NoteController),
                description: 'List notes of the current user',
            }),
            defineRoute({
                contract: noteContracts.create,
                handler: NoteController.createNote.bind(NoteController),
                description: 'Create a note for the current user',
            }),
        ],
        description: 'Note routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'notes',
    },
] satisfies routeList
```

`url`, `method`, `validator` і `ResponseSchema` у маршруті не пишуться: метод і шлях `defineRoute` бере з контракту, схеми — із запису реєстру. Шлях контракту `/notes` має починатися з префікса групи `notes`, інакше сервер не стартує. Тип payload обробника — вихід схеми `body`, тому `HttpContext<CreateNoteInput>` у контролері перевіряє компілятор. Результат контролера він звіряє зі схемою `response`: якщо `create` поверне не `CreateNoteResponse`, `tsc` впаде на рядку `handler:`. Анотацію `Promise<CreateNoteResponse>` у контролері лишайте — без неї літерали на кшталт `'success'` розширюються до `string` ([Тип відповіді хендлера](/backend/routing#тип-відповіді-хендлера)). Набір middleware `session_web` + `csrf_guard` + `auth_guard` такий самий, як у групи `avatar`. Отже, `POST` вимагає сесії й CSRF-токена (деталі — у [Маршрутизації](/backend/routing) і [Middleware](/backend/middlewares)).

Якщо додаєте оновлення або видалення нотатки: для часткового оновлення оголосіть контракт `'patch'` з типом тіла і схемою `body` у реєстрі, а для видалення — контракт `'delete'` зі шляхом `'/notes/:id'` і без тіла, бо `DELETE` тіло не читає ([Методи і тіло запиту](/backend/routing#методи-і-тіло-запиту)).

**Виклик з фронтенду.** Фронтенд викликає маршрути лише через [`callApi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) (прямі `baseApi.http`/`baseApi.upload` поза `utils/api-client.ts` забороняє ESLint). Неправильне тіло чи зайве поле — помилка компіляції у фронтенді:

```ts
// packages/frontend/src/utils/api.ts
import type { CreateNoteInput } from 'shared/schemas'
import { noteContracts } from 'shared/contracts'

export const noteApi = {
    list: () => callApi(noteContracts.list),
    create: (body: CreateNoteInput) => callApi(noteContracts.create, { body }),
}
```

## Крок 9. Тест сервісу

Тести сервісів лежать поряд із кодом і мокають barrel `#app/repositories/index.js` через `vi.mock`, як у [push-subscription-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/push-subscription-service.spec.ts). БД для них не потрібна.

```ts
// packages/backend/src/app/services/note/note-service.spec.ts
import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

const noteRepositoryMock = {
    create: vi.fn(),
    findByUserId: vi.fn(),
}

vi.mock('#app/repositories/index.js', () => ({
    noteRepository: noteRepositoryMock,
}))

async function loadNoteService() {
    return import('./note-service.js')
}

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

describe('noteService', () => {
    it('returns serialized notes of the user', async () => {
        noteRepositoryMock.findByUserId.mockResolvedValue([
            {
                id: 1n,
                userId: 7n,
                title: 'Hello',
                body: null,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
        ])

        const { noteService } = await loadNoteService()
        const result = await noteService.getNotes(7n)

        expect(noteRepositoryMock.findByUserId).toHaveBeenCalledWith(7n)
        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.notes).toHaveLength(1)
            expect(result.value.notes[0]).toMatchObject({
                id: '1',
                title: 'Hello',
                body: null,
            })
        }
    })

    it('creates a note with body defaulting to null', async () => {
        noteRepositoryMock.create.mockImplementation((data: Record<string, unknown>) =>
            Promise.resolve({ id: 2n, createdAt: new Date(), ...data }),
        )

        const { noteService } = await loadNoteService()
        const result = await noteService.createNote(7n, { title: 'Todo' })

        expect(noteRepositoryMock.create).toHaveBeenCalledWith({
            userId: 7n,
            title: 'Todo',
            body: null,
        })
        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.note.id).toBe('2')
        }
    })

    // An unexpected failure is not a Result: it reaches the HTTP layer, which answers 500.
    it('lets a repository failure through: the HTTP layer answers 500', async () => {
        noteRepositoryMock.findByUserId.mockRejectedValue(new Error('db down'))

        const { noteService } = await loadNoteService()

        await expect(noteService.getNotes(7n)).rejects.toThrow('db down')
    })
})
```

Transformer тут не мокається, тож тест перевіряє реальну серіалізацію (`1n` → `"1"`).

## Крок 10. Перевірка

```bash
pnpm --filter shared build
pnpm typecheck
pnpm --filter backend test
npx eslint packages/backend/src/app/services/note packages/backend/src/app/controllers/http/note \
  packages/backend/src/app/repositories/note packages/backend/src/app/transformers/note-transformer.ts \
  packages/backend/src/app/routes packages/shared/src/schemas/note \
  packages/shared/src/responses/note-controller.ts packages/shared/src/contracts/notes.ts
```

### Ручна перевірка: запити й відповіді

Застосуйте міграцію і запустіть проєкт:

```bash
pnpm --filter backend db:migrate
pnpm dev
```

Маршрути захищені сесією, тому спершу треба увійти. Як і в [першому сценарії](/guide/getting-started#те-саме-через-curl), cookie зберігаються в `cookies.txt`, а CSRF-токен береться з `GET /api/main/init`. Використайте demo-користувача з `SEED_USER_*`:

```bash
B=http://127.0.0.1:3000/api
O='origin: http://localhost:5173'   # curl не додає Origin сам, а сервер його вимагає
csrf() { curl -s -b cookies.txt -c cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/'; }

# вхід
curl -s -o /dev/null -b cookies.txt -c cookies.txt -H "$O" -H 'content-type: application/json' \
  -H "x-csrf-token: $(csrf)" \
  -d '{"identifier":"user@example.com","password":"<user-password>"}' $B/auth/login

CSRF=$(csrf)   # після входу токен новий
```

**Створити нотатку:**

```bash
curl -s -b cookies.txt -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"title":"Купити молоко","body":"2 літри"}' $B/notes
```

```json
{
    "status": "success",
    "note": {
        "id": "1",
        "title": "Купити молоко",
        "body": "2 літри",
        "created_at": "2026-10-25T15:23:05.794Z"
    }
}
```

Статус `200`. `created_at` — завжди UTC (`Z`): transformer віддає `toISOString()`, незалежно від часового поясу сервера. Без поля `body` нотатка теж створюється, і в відповіді буде `"body": null`.

**Отримати список** (найновіші першими):

```bash
curl -s -b cookies.txt $B/notes
```

```json
{
    "status": "success",
    "notes": [
        {
            "id": "2",
            "title": "Подзвонити",
            "body": null,
            "created_at": "2026-10-25T15:23:05.810Z"
        },
        {
            "id": "1",
            "title": "Купити молоко",
            "body": "2 літри",
            "created_at": "2026-10-25T15:23:05.794Z"
        }
    ]
}
```

**Помилкові запити.** Кожен рядок нижче перевірено на запущеному сервері:

| Запит                                | Статус | Відповідь (скорочено)                                                                                   | Хто зупинив                     |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `GET /notes` без cookie              | `401`  | `{"status":"error","code":"unauthorized","message":"Session expired or not found",...}`                 | `auth_guard`                    |
| `POST` з `{"title":""}`              | `422`  | `"code":"validation_failed"`, `"messages":["title must be non-empty"]`                                  | схема `CreateNoteInputSchema`   |
| `POST` з `{"title":"x","done":true}` | `422`  | `"messages":["done must be removed"]`                                                                   | `'+': 'reject'` у схемі         |
| `POST` з `content-type: text/plain`  | `415`  | `"code":"unsupported_media_type"`, `"allowedKinds":["json"]`                                            | ядро: маршрут приймає лише JSON |
| `POST` без `x-csrf-token`            | `403`  | `{"status":"error","code":"csrf_invalid","message":"Invalid CSRF token","reason":"token_mismatch",...}` | `csrf_guard`                    |

`CSRF_ENFORCE` за замовчуванням `true`, тож такий запит отримує `403`. Запит без заголовка `Origin` теж отримує `403`, але з `reason: "origin_mismatch"`. Як влаштований захист — [CSRF простими словами](/guide/csrf), деталі — [CSRF](/backend/security#csrf).

Те саме можна перевірити без curl в [API Playground](/playground/): він показує маршрути `notes` разом зі схемою тіла.

Перед мержем пройдіть повний Definition of Done з [AGENTS.md](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md): `pnpm typecheck`, `pnpm lint`, `pnpm test` і ручну перевірку вище.

## Типові помилки

- **Забули `pnpm --filter shared build`.** `typecheck`, тести й `start` бекенду не бачать нових експортів `shared` / `shared/schemas`, бо читають `dist/` (dev-сервер працює, бо читає `src/`).
- **Імпорт repository напряму з файлу**, а не з `#app/repositories/index.js`. Тоді `vi.mock` у тесті його не перехопить.
- **Повернення `bigint` або `Date` з контролера.** Завжди пропускайте рядки через transformer.
- **Кидання винятків із сервісу.** Повертайте `Result.err(...)`, а HTTP-статус виставить `mapControllerError`.

::: tip Наступний крок
[Свій проєкт на шаблоні](/guide/your-project): перейменування, інтерфейс і вибір інтеграцій для вашого продукту.
:::
