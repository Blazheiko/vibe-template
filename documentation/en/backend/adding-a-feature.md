# How to add a feature to the backend

This tutorial adds a new **`notes`** resource (the current user's notes) step by step, with two endpoints, `GET /api/notes` and `POST /api/notes`, and walks through every layer of the project architecture: shared schemas → Drizzle table and migration → repository → transformer → service → controller → contract and route registration → Vitest unit test.

::: info Before you read
Work through the [First route](/en/guide/first-endpoint) exercise: it shows the same layers (schema → service → controller → route) without a database. This tutorial adds a table, a migration, a repository, a transformer and session protection for the route.
:::

The overall picture of the layers is described in [Architecture](/en/backend/architecture), routing and middleware in [Routing](/en/backend/routing) and [Middleware](/en/backend/middlewares), working with the DB in [Database](/en/backend/database), and the path of a request in [Request lifecycle](/en/backend/request-lifecycle).

::: tip Verified in practice
All the code below was actually added to a clean copy of the repository, after which `pnpm --filter shared build`, `pnpm typecheck`, the full `pnpm --filter backend test` (including the new `note-service.spec.ts` and the `layering.spec.ts` layer check) and `npx eslint` for the changed files all passed, and the requests from step 10 were run against a live server. The existing push subscriptions feature was used as the model.
:::

## What will be created

| Layer                | File                                                                | Action    |
| -------------------- | ------------------------------------------------------------------- | --------- |
| Shared: input        | `packages/shared/src/schemas/note/create-note.ts`                   | new       |
| Shared: input        | `packages/shared/src/schemas/index.ts`                              | edit      |
| Shared: responses    | `packages/shared/src/responses/note-controller.ts`                  | new       |
| Shared: responses    | `packages/shared/src/responses/index.ts`                            | edit      |
| Table                | `packages/backend/src/database/schema.ts`                           | edit      |
| Migration            | `packages/backend/src/drizzle/migrations/<timestamp>_add_notes/`    | generated |
| Repository           | `packages/backend/src/app/repositories/note/note-repository.ts`     | new       |
| Repository (barrel)  | `packages/backend/src/app/repositories/index.ts`                    | edit      |
| Transformer          | `packages/backend/src/app/transformers/note-transformer.ts`         | new       |
| Transformer (barrel) | `packages/backend/src/app/transformers/index.ts`                    | edit      |
| Service              | `packages/backend/src/app/services/note/note-service.ts`            | new       |
| Controller           | `packages/backend/src/app/controllers/http/note/note-controller.ts` | new       |
| Shared: contract     | `packages/shared/src/contracts/notes.ts`                            | new       |
| Shared: contract     | `packages/shared/src/contracts/index.ts`                            | edit      |
| Schema registry      | `packages/backend/src/app/routes/contract-schemas/notes.ts`         | new       |
| Schema registry      | `packages/backend/src/app/routes/contract-schemas/index.ts`         | edit      |
| Routes               | `packages/backend/src/app/routes/http-routes.ts`                    | edit      |
| Frontend call        | `packages/frontend/src/utils/api.ts`                                | edit      |
| Test                 | `packages/backend/src/app/services/note/note-service.spec.ts`       | new       |

## Step 1. Input schema in `shared`

Input payloads are described with ArkType schemas in `packages/shared/src/schemas/<domain>/`. The `"+": "reject"` key forbids extra fields, just like in [create-subscription.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/push-subscription/create-subscription.ts).

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

Export the schema and the type from [packages/shared/src/schemas/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/index.ts) (they are imported from there as `shared/schemas`):

```ts
export { CreateNoteInputSchema, type CreateNoteInput } from './note/create-note.js'
```

## Step 2. Response schemas in `shared`

Controller responses live in `packages/shared/src/responses/` and are built as `type.or(<success>, CanonicalErrorResponseSchema)`, see [push-subscription-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/push-subscription-controller.ts) and [error-response.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/error-response.ts). The `Note` type is the public contract that the transformer returns. The server checks every response of the route against this schema in any environment: a mismatch gives a `500`, and an extra field is a `500` outside production and is stripped in production (the `log` mode) — see [Response validation](/en/backend/response-validation).

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

Add a line to [packages/shared/src/responses/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/index.ts):

```ts
export * from './note-controller.js'
```

The backend consumes `shared` through `dist/` (see `exports` in [packages/shared/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/package.json)), so after the changes you **must** rebuild the package. Only the dev server (`pnpm dev`) reads `src/` through the `shared-source` condition and sees changes without a build:

```bash
pnpm --filter shared build
```

## Step 3. Table and migration

Add the table to the end of [packages/backend/src/database/schema.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/schema.ts). All the helpers you need (`pgTable`, `bigserial`, `bigint`, `varchar`, `text`, `timestamp`, `index`) are already imported there, and `users` is declared higher up in the file.

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

::: warning Time zone
A `timestamp` column without a time zone: Drizzle writes and reads a JS `Date` as UTC, while `now()` is evaluated in the PostgreSQL session's time zone. That is why all application connections and `db:seed` are opened with `TimeZone=UTC` ([`pool-options.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/pool-options.ts)), and `created_at` does not shift even if the PostgreSQL server is configured with a different zone. A direct SQL client (psql etc.) sees values in UTC only if it sets `SET TimeZone = 'UTC'` itself.
:::

Generate the migration ([drizzle.config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/drizzle.config.ts) writes them to `src/drizzle/migrations` in the "folder per migration" format):

```bash
pnpm --filter backend db:generate --name add_notes
```

`drizzle-kit generate` compares the schema with the previous snapshots and **does not need a running DB**. The result is `src/drizzle/migrations/<timestamp>_add_notes/migration.sql`:

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

To apply the migration to a live DB, run `pnpm --filter backend db:migrate` (you need PostgreSQL configured with the `PGSQL_*` settings). In this example the relation goes only through `userId`, so we leave [relations.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/relations.ts) unchanged.

## Step 4. Repository

The repository is the only place where Drizzle queries are run. The pattern is taken from [push-subscription-repository.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/notifications/push-subscription-repository.ts): row types via `InferSelectModel` / `InferInsertModel`, an `I...Repository` interface and an implementation object.

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

Add the export to the [repositories/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/index.ts) barrel. Services import the repository from there, and this is the module that gets mocked in tests:

```ts
export { noteRepository } from './note/note-repository.js'
export type { NoteRow, NoteInsert } from './note/note-repository.js'
```

## Step 5. Transformer

The transformer turns a DB row into a public DTO: `bigint` → `string`, `Date` → a UTC ISO string via `toISOString()`, as in [push-subscription-transformer.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/push-subscription-transformer.ts). Internal fields (`userId`) are not exposed.

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

The `NoteRow` type is imported from the `#app/repositories/index.js` barrel, not from the repository file: a direct import outside `app/repositories` is forbidden, and [`layering.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/layering.spec.ts) will fail on it.

Export in [transformers/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/index.ts):

```ts
export { noteTransformer } from './note-transformer.js'
```

## Step 6. Service

The service holds the business logic. It returns expected outcomes (not found, conflict, limit) as `AppResult<T>` (a `Result` from `better-result`, see [errors.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/shared/errors.ts)). Repository calls are not wrapped: a DB failure is thrown, and the transport responds with 500, a log entry and a Sentry event ([ADR 0004](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0004-result-for-expected-outcomes.md)).

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

## Step 7. Controller

The controller is a thin layer. It gets `userId` from `context.auth`, takes the already validated payload via `getTypedPayload`, calls the service and returns `respond(context, result, toBody)`: an error becomes a canonical response with the correct HTTP status (`mapControllerError`), and a value becomes the body via `toBody`. All the `context` fields (`httpData`, `responseData`, `session`, `auth`, `logger`) are described in [HttpContext in detail](/en/backend/controllers#httpcontext-in-detail). The structure is taken from [push-subscription-controller.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/notifications/push-subscription-controller.ts).

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

Authentication is guaranteed by the `auth_guard` middleware on the route group (next step). The `userId === null` check is only a defensive branch for typing.

If an action has nothing to return (for example, a delete), the handler returns `null`: the response will be `204 No Content` with no body, while an explicitly set 201 or 202 is preserved. Details are in [Response without data](/en/backend/request-lifecycle#response-without-data).

## Step 8. Contract and route registration

Every HTTP route of the application is declared through a contract ([ADR 0005](https://github.com/Blazheiko/vibe-template/blob/main/docs/adr/0005-route-contracts.md), [Routing](/en/backend/routing#http-routes-defineroute)). ESLint forbids the helper for a route without a contract (`defineRawRoute`) in application code, and a route without a contract or without a registry entry fails the test [`route-contracts.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/route-contracts.spec.ts). The notes need three parts: a contract in `shared`, an entry in the schema registry and the routes themselves.

**The contract.** It describes the method, the full path under the API prefix and the types of the body, query and response. The schemas are imported only as types (`import type`), so they do not reach the browser bundle. The model is [push-subscriptions.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/push-subscriptions.ts):

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

Export the group from [packages/shared/src/contracts/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/index.ts) (it is imported from there as `shared/contracts`) and rebuild `shared` again:

```ts
export { noteContracts } from './notes.js'
```

**The schema registry.** Route schemas live in the backend, one file per contract group. [`contractSchemas`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routing/contract-registry.ts) requires an entry for every contract of the group and checks it against the contract's types: if the input of `CreateNoteInputSchema` drifts from the contract's body type or you forget the entry for `list`, `pnpm typecheck` fails.

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

Spread the group into `contractSchemaRegistry` in [contract-schemas/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/contract-schemas/index.ts):

```ts
import { noteSchemas } from './notes.js'
// ...
export const contractSchemaRegistry = {
    // ...
    ...noteSchemas,
}
```

**The routes.** In [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts) `defineRoute` is already imported from `#app/routes/contract-schemas/index.js`. Add the controller import (next to the others) and append `noteContracts` to the existing import from `shared/contracts`:

```ts
import NoteController from '#app/controllers/http/note/note-controller.js'
// ...
import {
    // ...
    supportContracts,
    noteContracts,
} from 'shared/contracts'
```

Then add the group as the last element of the array, before `] satisfies routeList`:

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

The route does not write `url`, `method`, `validator` or `ResponseSchema`: `defineRoute` takes the method and the path from the contract and the schemas from the registry entry. The contract path `/notes` must start with the group prefix `notes`, otherwise the server does not start. The handler's payload type is the output of the `body` schema, so the compiler checks `HttpContext<CreateNoteInput>` in the controller. It compares the controller's result with the `response` schema: if `create` returns something other than `CreateNoteResponse`, `tsc` fails on the `handler:` line. Keep the `Promise<CreateNoteResponse>` annotation in the controller — without it, literals like `'success'` widen to `string` ([Handler response type](/en/backend/routing#handler-response-type)). The `session_web` + `csrf_guard` + `auth_guard` middleware set is the same as for the `avatar` group. So `POST` requires a session and a CSRF token (details in [Routing](/en/backend/routing) and [Middleware](/en/backend/middlewares)).

If you add updating or deleting a note: for a partial update declare a `'patch'` contract with a body type and a `body` schema in the registry, and for deletion a `'delete'` contract with the path `'/notes/:id'` and no body, because `DELETE` does not read a body ([Methods and request body](/en/backend/routing#methods-and-request-body)).

**Calling from the frontend.** The frontend calls routes only through [`callApi`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/api-client.ts) (ESLint forbids direct `baseApi.http`/`baseApi.upload` outside `utils/api-client.ts`). A wrong body or an extra field is a compile error in the frontend:

```ts
// packages/frontend/src/utils/api.ts
import type { CreateNoteInput } from 'shared/schemas'
import { noteContracts } from 'shared/contracts'

export const noteApi = {
    list: () => callApi(noteContracts.list),
    create: (body: CreateNoteInput) => callApi(noteContracts.create, { body }),
}
```

## Step 9. Service test

Service tests live next to the code and mock the `#app/repositories/index.js` barrel via `vi.mock`, as in [push-subscription-service.spec.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/push-subscription-service.spec.ts). They do not need a DB.

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

The transformer is not mocked here, so the test checks the real serialization (`1n` → `"1"`).

## Step 10. Verification

```bash
pnpm --filter shared build
pnpm typecheck
pnpm --filter backend test
npx eslint packages/backend/src/app/services/note packages/backend/src/app/controllers/http/note \
  packages/backend/src/app/repositories/note packages/backend/src/app/transformers/note-transformer.ts \
  packages/backend/src/app/routes packages/shared/src/schemas/note \
  packages/shared/src/responses/note-controller.ts packages/shared/src/contracts/notes.ts
```

### Manual verification: requests and responses

Apply the migration and start the project:

```bash
pnpm --filter backend db:migrate
pnpm dev
```

The routes are protected by a session, so you have to log in first. As in the [first scenario](/en/guide/getting-started#the-same-with-curl), cookies are stored in `cookies.txt`, and the CSRF token comes from `GET /api/main/init`. Use the demo user from `SEED_USER_*`:

```bash
B=http://127.0.0.1:3000/api
O='origin: http://localhost:5173'   # curl does not add Origin itself, but the server requires it
csrf() { curl -s -b cookies.txt -c cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/'; }

# log in
curl -s -o /dev/null -b cookies.txt -c cookies.txt -H "$O" -H 'content-type: application/json' \
  -H "x-csrf-token: $(csrf)" \
  -d '{"identifier":"user@example.com","password":"<user-password>"}' $B/auth/login

CSRF=$(csrf)   # the token is new after login
```

**Create a note:**

```bash
curl -s -b cookies.txt -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"title":"Buy milk","body":"2 liters"}' $B/notes
```

```json
{
    "status": "success",
    "note": {
        "id": "1",
        "title": "Buy milk",
        "body": "2 liters",
        "created_at": "2026-10-25T15:23:05.794Z"
    }
}
```

Status `200`. `created_at` is always UTC (`Z`): the transformer returns `toISOString()`, whatever the time zone of the server. Without the `body` field the note is created too, and the response will have `"body": null`.

**Get the list** (newest first):

```bash
curl -s -b cookies.txt $B/notes
```

```json
{
    "status": "success",
    "notes": [
        {
            "id": "2",
            "title": "Call",
            "body": null,
            "created_at": "2026-10-25T15:23:05.810Z"
        },
        {
            "id": "1",
            "title": "Buy milk",
            "body": "2 liters",
            "created_at": "2026-10-25T15:23:05.794Z"
        }
    ]
}
```

**Failing requests.** Every row below was verified on a running server:

| Request                                 | Status | Response (abridged)                                                                                     | Stopped by                        |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `GET /notes` without a cookie           | `401`  | `{"status":"error","code":"unauthorized","message":"Session expired or not found",...}`                 | `auth_guard`                      |
| `POST` with `{"title":""}`              | `422`  | `"code":"validation_failed"`, `"messages":["title must be non-empty"]`                                  | `CreateNoteInputSchema` schema    |
| `POST` with `{"title":"x","done":true}` | `422`  | `"messages":["done must be removed"]`                                                                   | `'+': 'reject'` in the schema     |
| `POST` with `content-type: text/plain`  | `415`  | `"code":"unsupported_media_type"`, `"allowedKinds":["json"]`                                            | core: the route accepts only JSON |
| `POST` without `x-csrf-token`           | `403`  | `{"status":"error","code":"csrf_invalid","message":"Invalid CSRF token","reason":"token_mismatch",...}` | `csrf_guard`                      |

`CSRF_ENFORCE` defaults to `true`, so such a request gets `403`. A request without an `Origin` header also gets `403`, but with `reason: "origin_mismatch"`. How the protection works is covered in [CSRF in plain words](/en/guide/csrf), with details in [CSRF](/en/backend/security#csrf).

You can check the same thing without curl in the [API Playground](/en/playground/): it shows the `notes` routes together with the body schema.

Before merging, go through the full Definition of Done from [AGENTS.md](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md): `pnpm typecheck`, `pnpm lint`, `pnpm test` and the manual verification above.

## Common mistakes

- **Forgot `pnpm --filter shared build`.** The backend's `typecheck`, tests and `start` do not see the new `shared` / `shared/schemas` exports, because they read `dist/` (the dev server works, since it reads `src/`).
- **Importing the repository directly from its file**, not from `#app/repositories/index.js`. Then `vi.mock` in the test will not intercept it.
- **Returning a `bigint` or a `Date` from a controller.** Always pass rows through the transformer.
- **Throwing exceptions from a service.** Return `Result.err(...)`, and `mapControllerError` will set the HTTP status.

::: tip Next step
[Your project on the template](/en/guide/your-project): renaming, the interface and choosing integrations for your product.
:::
