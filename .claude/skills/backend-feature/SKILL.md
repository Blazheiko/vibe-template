---
name: backend-feature
description: >
    Scaffolds a complete new backend feature following the layered architecture of this project
    (shared schemas/responses → Drizzle table + migration → repository → transformer → service →
    controller → contract + schema registry + route → service test → docs).
    Use this skill whenever the user wants to add a new resource, endpoint, domain, or API feature
    to the backend — even if they just say "add X feature", "create Y endpoint", "I need an API for Z",
    or "how do I add X to the backend". The skill generates all files in the correct order
    with the correct patterns, so nothing is missed and nothing violates the architecture.
---

# Backend Feature Scaffold

The source of truth is the project's own tutorial, verified against the code:
`documentation/en/backend/adding-a-feature.md` (UA twin: `documentation/backend/adding-a-feature.md`).
**Read it first** — if it and this skill disagree, the tutorial and the code win; tell the user the
skill is stale. The living model of a full CRUD resource is the push subscriptions feature:
`shared/src/{schemas/push-subscription,responses/push-subscription-controller.ts,contracts/push-subscriptions.ts}`,
`backend/src/app/{repositories,services,controllers/http}/notifications/push-subscription-*`,
`backend/src/app/routes/contract-schemas/push-subscriptions.ts`.

Example names below use `notes` (`NoteRow`, `noteRepository`, `noteTransformer`, `noteService`,
`NoteController`, `noteContracts`, prefix `notes`). Code style: 4 spaces, single quotes, no
semicolons, 100 columns.

## Step 0: Process (AGENTS.md)

- New work needs a `feat-XXX` row in `feature_list.json` (via PR to `main`) and its own branch with
  `feature-state/<feat-id>/progress.md`. Don't start on `main`.
- A new route / env / migration changes public backend behaviour → update the matching page in
  `documentation/backend/` **and** `documentation/en/backend/` in the same PR.

## Step 1: Clarify the feature

Ask only what the request does not already answer:

1. **Resource name** (singular + plural).
2. **Transport** — HTTP, WebSocket, or both.
3. **Operations** — list, get one, create, update (partial → `patch`), delete.
4. **Access** — signed-in user (`session_web` + `csrf_guard` + `auth_guard`, default), admin
   (`admin_guard`), or public.
5. **DB table** — exists in `src/database/schema.ts` or new?
6. **Can an account claim undo it?** Writes to user-owned rows that a claim must be able to remove
   go through `withCurrentSession` (feat-098), see Step 6.

## Step 2: Shared — input schemas

`packages/shared/src/schemas/<resource>/<op>-<resource>.ts`. ArkType is imported from
`@arktype/type` (not `arktype`). Always bound strings/arrays to the DB column sizes and add
`'+': 'reject'`.

```ts
import { type } from '@arktype/type'

export const CreateNoteInputSchema = type({
    title: '1 <= string <= 200',
    'body?': 'string <= 5000',
    '+': 'reject',
})
export type CreateNoteInput = typeof CreateNoteInputSchema.infer
```

Export from `packages/shared/src/schemas/index.ts`:
`export { CreateNoteInputSchema, type CreateNoteInput } from './note/create-note.js'`.
Query inputs live in `schemas/query/`. A body route that reads nothing uses `EmptyFormInputSchema`
(`schemas/common/empty-form.ts`).

## Step 3: Shared — response schemas

`packages/shared/src/responses/<resource>-controller.ts`. Each response is
`type.or(<success>, CanonicalErrorResponseSchema)`; success uses `status: "'success'"`.
Response schemas are an **allow-list** (feat-046): every field the client gets is listed, an extra
field is a 500 outside production. IDs are `'string'`, dates `'string'` (ISO UTC).

```ts
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
```

Add `export * from './note-controller.js'` to `responses/index.ts`.

**Then `pnpm --filter shared build`** — backend typecheck/tests/start read `shared` from `dist/`
(only `pnpm dev` reads `src/`). Rebuild again after adding contracts.

## Step 4: Table and migration (if new)

Append to `packages/backend/src/database/schema.ts`:

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
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [index('notes_user_id_idx').on(table.userId)],
)
```

- `timestamp` without time zone; connections run with `TimeZone=UTC` (`database/pool-options.ts`).
- Relations, if needed, go into `src/database/relations.ts` (Relational Queries v2, `defineRelations`).
- Generate (no DB needed): `pnpm --filter backend db:generate --name add_notes` → folder
  `src/drizzle/migrations/<timestamp>_add_notes/migration.sql`. Apply: `pnpm --filter backend db:migrate`.
- drizzle-orm / drizzle-kit are pinned to `1.0.0-rc.5`; don't upgrade them as part of a feature.

## Step 5: Repository

`packages/backend/src/app/repositories/<domain>/<resource>-repository.ts` (domain subfolder, e.g.
`note/`, `notifications/`). Drizzle only: no HTTP, no logging (`layering.spec.ts` forbids `#logger`),
no business decisions. Export an `I…Repository` interface and an object implementing it. Methods that
may run inside a transaction take `executor: DbExecutor = db` (`../transaction.js`). Scope user-owned
queries by `userId`.

```ts
import { db } from '#database/db.js'
import { notes } from '#database/schema.js'
import { and, desc, eq } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'

export type NoteRow = InferSelectModel<typeof notes>
export type NoteInsert = InferInsertModel<typeof notes>
export type NoteUpdate = Partial<Pick<NoteInsert, 'title' | 'body'>>

export interface INoteRepository {
    create(data: NoteInsert, executor?: DbExecutor): Promise<NoteRow>
    findByIdAndUserId(id: bigint, userId: bigint): Promise<NoteRow | undefined>
    findByUserId(userId: bigint): Promise<NoteRow[]>
    update(
        id: bigint,
        userId: bigint,
        data: NoteUpdate,
        executor?: DbExecutor,
    ): Promise<NoteRow | undefined>
    delete(id: bigint, userId: bigint): Promise<boolean>
}

export const noteRepository: INoteRepository = {
    async create(data, executor = db) {
        const [created] = await executor.insert(notes).values(data).returning()
        if (created === undefined) throw new Error('Failed to create note')
        return created
    },
    async findByIdAndUserId(id, userId) {
        return await db
            .select()
            .from(notes)
            .where(and(eq(notes.id, id), eq(notes.userId, userId)))
            .limit(1)
            .then((rows) => rows.at(0))
    },
    async findByUserId(userId) {
        return await db
            .select()
            .from(notes)
            .where(eq(notes.userId, userId))
            .orderBy(desc(notes.createdAt))
    },
    async update(id, userId, data, executor = db) {
        const [updated] = await executor
            .update(notes)
            .set(data)
            .where(and(eq(notes.id, id), eq(notes.userId, userId)))
            .returning()
        return updated
    },
    async delete(id, userId) {
        const deleted = await db
            .delete(notes)
            .where(and(eq(notes.id, id), eq(notes.userId, userId)))
            .returning({ id: notes.id })
        return deleted.length > 0
    },
}
```

Export value **and** types from the barrel `repositories/index.ts` — `layering.spec.ts` fails if a
`*-repository.ts` is missing from it, and everything outside `app/repositories` must import through
`#app/repositories/index.js` (that is also what tests mock).

## Step 6: Transformer

`packages/backend/src/app/transformers/<resource>-transformer.ts`, exported from `transformers/index.ts`.
`bigint` → `String(id)`, `Date` → `toISOString()` (no luxon). Return the shared wire type (`Note`) and
list fields explicitly — don't spread the row, so server-only columns (`userId`, keys, IPs) never leak.

```ts
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

## Step 7: Service

`packages/backend/src/app/services/<domain>/<resource>-service.ts`. Expected outcomes are
`AppResult<T>` (`Result` from `better-result`) built with the helpers in
`#app/services/shared/errors.js` (`notFound(resource, msg)`, `conflict`, `badRequest`, `forbidden`,
`rateLimited`, …). Repository calls are **not** wrapped: an unexpected DB failure throws and the
transport answers 500 + log + Sentry (ADR 0004). No HTTP status codes, no `context`, no
`#database/*` imports (`layering.spec.ts`).

```ts
import { Result } from 'better-result'
import type { CreateNoteInput, UpdateNoteInput } from 'shared/schemas'
import type { Note } from 'shared'
import { noteRepository } from '#app/repositories/index.js'
import { noteTransformer } from '#app/transformers/index.js'
import { notFound, type AppResult } from '#app/services/shared/errors.js'
import { withCurrentSession } from '#app/services/auth/session-guard.js'

const noteNotFound = () => notFound('Note', 'Note not found')

export const noteService = {
    async getNotes(userId: bigint): Promise<AppResult<{ notes: Note[] }>> {
        const rows = await noteRepository.findByUserId(userId)
        return Result.ok({ notes: noteTransformer.serializeArray(rows) })
    },

    async getNote(userId: bigint, noteId: bigint): Promise<AppResult<{ note: Note }>> {
        const row = await noteRepository.findByIdAndUserId(noteId, userId)
        if (row === undefined) return Result.err(noteNotFound())
        return Result.ok({ note: noteTransformer.serialize(row) })
    },

    // Only if an account claim must be able to undo the write (feat-098): runs under the user's
    // row lock while the presented session token is current, else 401 session_revoked.
    async createNote(
        userId: bigint,
        payload: CreateNoteInput,
        presentedSessionToken: string | undefined,
    ): Promise<AppResult<{ note: Note }>> {
        return await withCurrentSession(userId, presentedSessionToken, async (tx) => {
            const created = await noteRepository.create(
                { userId, title: payload.title, body: payload.body ?? null },
                tx,
            )
            return Result.ok({ note: noteTransformer.serialize(created) })
        })
    },

    async deleteNote(userId: bigint, noteId: bigint): Promise<AppResult<null>> {
        const deleted = await noteRepository.delete(noteId, userId)
        return deleted ? Result.ok(null) : Result.err(noteNotFound())
    },
}
```

Without the claim requirement, call the repository directly (as the tutorial does). A multi-step
write that must roll back on `Result.err` uses `withTransactionResult` (`services/shared/transaction-result.ts`).

## Step 8: Controller

`packages/backend/src/app/controllers/http/<domain>/<resource>-controller.ts`, default-exported plain
object. Transport only. Use the shared helpers — don't write local status maps:

- `requireUserId(context)` (`#app/controllers/shared/require-user-id.js`) → `bigint | null`;
  on `null` return `mapControllerError(context, unauthorized())`.
- `parseEntityId(raw)` (`#app/controllers/shared/parse-id.js`) for path ids — a non-numeric id is a
  404, never a `BigInt` 500.
- `respond(context, result, toBody)` (`#app/controllers/shared/controller-error.js`) ends a handler.
- Type params from the contract: `HttpContext<Payload, Query, ParamsOf<typeof noteContracts.get>>`
  (`ParamsOf` from `#app/routing/contract-registry.js`) — a renamed `:noteId` then breaks the build.
- Annotate the return type (`Promise<GetNotesResponse>`) so `'success'` doesn't widen to `string`.
- Return `null` for "no content" → 204 (an explicit 201/202 is kept).

```ts
import type { HttpContext } from '#vendor/types/types.js'
import type { ParamsOf } from '#app/routing/contract-registry.js'
import type { noteContracts } from 'shared/contracts'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { parseEntityId } from '#app/controllers/shared/parse-id.js'
import { noteService } from '#app/services/note/note-service.js'
import { notFound, unauthorized } from '#app/services/shared/errors.js'
import type { CreateNoteResponse, GetNoteResponse, GetNotesResponse } from 'shared'
import type { CreateNoteInput } from 'shared/schemas'

type Nc = typeof noteContracts

export default {
    async getNotes(context: HttpContext): Promise<GetNotesResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        const result = await noteService.getNotes(userId)
        return respond(context, result, (value) => ({ status: 'success', notes: value.notes }))
    },

    async getNote(
        context: HttpContext<unknown, null, ParamsOf<Nc['get']>>,
    ): Promise<GetNoteResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const noteId = parseEntityId(context.httpData.params.noteId)
        if (noteId === null) return mapControllerError(context, notFound('Note', 'Note not found'))

        const result = await noteService.getNote(userId, noteId)
        return respond(context, result, (value) => ({ status: 'success', note: value.note }))
    },

    async createNote(context: HttpContext<CreateNoteInput>): Promise<CreateNoteResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        const payload = getTypedPayload(context)
        const result = await noteService.createNote(
            userId,
            payload,
            context.auth.getPresentedUserToken(),
        )
        return respond(context, result, (value) => ({ status: 'success', note: value.note }))
    },
}
```

Controllers never import repositories or `db` (`layering.spec.ts`).

## Step 9: Contract, schema registry, route

Every HTTP route goes through a contract (ADR 0005, `docs/adr/0005-route-contracts.md`).

**Contract** — `packages/shared/src/contracts/<resources>.ts`, schemas imported **only as types**;
export the group from `contracts/index.ts`, then rebuild `shared`.

```ts
import type { CreateNoteInputSchema } from '../schemas/note/create-note.js'
import type { UpdateNoteInputSchema } from '../schemas/note/update-note.js'
import type {
    CreateNoteResponse,
    DeleteNoteResponse,
    GetNoteResponse,
    GetNotesResponse,
    UpdateNoteResponse,
} from '../responses/note-controller.js'
import { contract } from './core.js'

export const noteContracts = {
    list: contract<undefined, undefined, GetNotesResponse>()('get', '/notes'),
    get: contract<undefined, undefined, GetNoteResponse>()('get', '/notes/:noteId'),
    create: contract<typeof CreateNoteInputSchema.inferIn, undefined, CreateNoteResponse>()(
        'post',
        '/notes',
    ),
    update: contract<typeof UpdateNoteInputSchema.inferIn, undefined, UpdateNoteResponse>()(
        'patch',
        '/notes/:noteId',
    ),
    remove: contract<undefined, undefined, DeleteNoteResponse>()('delete', '/notes/:noteId'),
} as const
```

Query → 2nd type parameter (`*QueryInput` from `schemas/query/`). File upload →
`multipartContract<Fields, 'fileField', Response>()('post', path)`. A GET the browser opens itself
(redirect, `<img>`) → `navigationContract<Query, Response>()(path)`. `DELETE` reads no body.

**Registry** — `packages/backend/src/app/routes/contract-schemas/<resources>.ts`:

```ts
import { CreateNoteInputSchema, UpdateNoteInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { noteContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const noteSchemas = contractSchemas(noteContracts, {
    list: { response: ResponseSchemas.GetNotesResponseSchema },
    get: { response: ResponseSchemas.GetNoteResponseSchema },
    create: { body: CreateNoteInputSchema, response: ResponseSchemas.CreateNoteResponseSchema },
    update: { body: UpdateNoteInputSchema, response: ResponseSchemas.UpdateNoteResponseSchema },
    remove: { response: ResponseSchemas.DeleteNoteResponseSchema },
})
```

Pass `noteSchemas` as an argument to `mergeContractSchemas(...)` in `contract-schemas/index.ts`
(**not** a spread — duplicate `<method> <path>` then stops the import). Every contract needs an entry;
a body route (post/put/patch) needs a `body` schema (`route-contracts.spec.ts`).

**Route** — `packages/backend/src/app/routes/http-routes.ts`: import the controller, add `noteContracts`
to the `shared/contracts` import, append a group before `] satisfies routeList`. `defineRoute`
takes contract + handler + server settings only (no `url`, `method`, `validator`, `ResponseSchema`).
The contract path must start with the group `prefix`.

```ts
{
    group: [
        defineRoute({
            contract: noteContracts.list,
            handler: NoteController.getNotes.bind(NoteController),
            description: 'List notes of the current user',
        }),
        // … get / create / update / remove
    ],
    description: 'Note routes',
    middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
    prefix: 'notes',
    // optional: rateLimit: { windowMs: 60_000, maxRequests: 10 }
},
```

Per-route options: `middlewares`, `rateLimit`, `maxBodySize` (`multipartBodyLimit(...)` from
`#app/services/shared/upload-limits.js`), `signedInBeforeBody: true` for uploads.
`session_web` / `csrf_guard` stay explicit per group — don't propose global wiring.
Never use `defineRawRoute` in app code (ESLint forbids it outside tests).

**Frontend** — `packages/frontend/src/utils/api.ts`: `callApi(noteContracts.create, { body })`,
`callApi(noteContracts.get, { params: { noteId } })` from `@/utils/api-client` (3rd arg: transport
options like `csrfRecovery`, `signal`). Direct `baseApi.http` / `baseApi.upload` is an ESLint error.
A navigation contract URL comes from `contractUrl(contract, { params })`.

## Step 10: Service test

`packages/backend/src/app/services/<domain>/<resource>-service.spec.ts`, next to the code. Mock the
barrel `#app/repositories/index.js` with `vi.mock`, load the service via dynamic `import()`,
`vi.resetModules()` + `vi.clearAllMocks()` in `afterEach`, don't mock the transformer, assert with
`Result.isOk` / `Result.isError`, and include a test that a repository failure **rejects** (not a
Result). Copy the shape from the tutorial's Step 9 or `push-subscription-service.spec.ts`.
Code using `withCurrentSession` also needs `userRepository.lockById` / `withTransaction` in the mock.

## Step 11: Verify (Definition of Done)

```bash
pnpm --filter shared build
pnpm typecheck
pnpm lint
pnpm test            # includes layering.spec.ts and route-contracts.spec.ts
pnpm format:check
```

Manual golden path: `db:migrate`, `pnpm dev`, log in and call the routes with curl (cookies, `Origin`
header, `x-csrf-token` from `GET /api/main/init`) — recipe in the tutorial's Step 10. Record the
evidence in `feature-state/<feat-id>/progress.md`. If docs changed: `pnpm docs:build && pnpm docs:verify`.

## Step 12: WebSocket routes (if requested)

Same chain (ADR 0006, `docs/adr/0006-websocket-contracts.md`): contract → registry → controller → route → `callWs`.

1. **Contract** in `packages/shared/src/contracts/ws.ts`; the path is `/<prefix>/<event>`:
   `noteWsContracts = { update: wsContract<typeof UpdateNoteWsInputSchema.inferIn, UpdateNoteWsResponse>()('/notes/note_update') } as const`
2. **Registry** in `backend/src/app/routes/contract-schemas/ws.ts`:
   `export const noteWsSchemas = contractSchemas(noteWsContracts, { update: { body: …, response: … } })`,
   then add it to `mergeContractSchemas(...)`.
3. **Controller** in `backend/src/app/controllers/ws/`. `WsContext` has no `session`/`auth`; the user
   is `context.userData` (`null` when anonymous). Errors via `respondWs` / `mapWsControllerError`.

    ```ts
    async update(context: WsContext<UpdateNoteWsInput>): Promise<UpdateNoteWsResponse> {
        const { userData } = context
        if (userData?.userId === undefined) return appErrorToPayload(unauthorized())
        const payload = getTypedPayload(context)
        const result = await noteService.updateNote(BigInt(userData.userId), …)
        return respondWs(context, result, (value) => ({ status: 'ok', note: value.note }))
    }
    ```

4. **Route** in `backend/src/app/routes/ws-routes.ts` with `defineWsRoute({ contract, handler, description })`
   inside a group with matching `prefix` and a `rateLimit` (admin groups add `middlewares: ['ws_admin_guard']`).
   Never `defineRawWsRoute` in app code.
5. **Frontend**: `await callWs(noteWsContracts.update, payload)` from `@/utils/ws-client`.

## Checklist

- [ ] Feature row + branch + `feature-state/<feat-id>/progress.md` (Step 0)
- [ ] Input schemas (`@arktype/type`, bounded, `'+': 'reject'`) exported from `schemas/index.ts`
- [ ] Response schemas (`type.or(..., CanonicalErrorResponseSchema)`, allow-list) exported from `responses/index.ts`
- [ ] Table + generated migration folder (`db:generate --name …`), relations if needed
- [ ] Repository in a domain subfolder, interface + object, exported (value + types) from the barrel
- [ ] Transformer (string ids, ISO dates, explicit fields) exported from `transformers/index.ts`
- [ ] Service returns `AppResult`, uses `errors.ts` helpers, `withCurrentSession` where a claim must undo the write
- [ ] Controller uses `requireUserId`, `parseEntityId`, `respond`, `ParamsOf`, annotated return type
- [ ] Contract group exported from `contracts/index.ts`; registry passed to `mergeContractSchemas`
- [ ] Route group with `defineRoute` and the right middlewares
- [ ] `shared` rebuilt; service spec added; typecheck/lint/test/format clean
- [ ] `documentation/backend/` + `documentation/en/backend/` updated (new page → sidebars + `KEY_PAGES`/`EN_KEY_PAGES`)

## Architecture rules (enforced by `layering.spec.ts`, ESLint and the tests)

- Controllers, middlewares, websocket never import `#app/repositories`; outside `app/repositories`
  repositories come only from the barrel.
- Repositories: Drizzle only, no logging. Services: no `#database/db.js` / `#database/schema.js`.
- Services return `AppResult<T>` for expected outcomes; unexpected failures throw.
- Never return a `bigint` or `Date` from a controller — always through the transformer.
- Shared package: types and schemas only, no Node.js imports. Contracts import schemas as types only.
- Aliases: `#app/*`, `#config/*`, `#vendor/*`, `#database/*`, `#drizzle/*`, `#logger`; no `../../` across layers.
