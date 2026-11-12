import { type } from '@arktype/type'
import { describe, expect, it, vi } from 'vitest'
import { contract, multipartContract, navigationContract, wsContract } from 'shared/contracts'
import { CanonicalErrorResponseSchema } from 'shared/responses'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { contractRouteDefiner, contractSchemas, contractWsRouteDefiner, mergeContractSchemas } =
    await import('./contract-registry.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { getTypedPayload } = await import('#vendor/utils/validation/get-typed-payload.js')
const { default: appConfig } = await import('#config/app.js')

// docs/adr/0005-route-contracts.md: a route declared through a contract takes its method and
// path from it and its schemas from the registry entry of the contract; the compiler checks each
// entry against the contract's types (feat-172).

const NoteInputSchema = type({ text: '1 <= string <= 200', '+': 'reject' })
const NoteQuerySchema = type({ 'limit?': 'string.integer.parse', 'tag?': 'string' })
const NoteResponseSchema = type.or(
    { status: "'success'", id: 'string' },
    CanonicalErrorResponseSchema,
)
type NoteResponse = typeof NoteResponseSchema.infer

const notes = {
    create: contract<typeof NoteInputSchema.inferIn, undefined, NoteResponse>()('post', '/notes'),
    list: contract<undefined, { limit?: number | string; tag?: string }, NoteResponse>()(
        'get',
        '/notes',
    ),
    remove: contract<undefined, undefined, NoteResponse>()('delete', '/notes/:noteId'),
}

const answer = (): NoteResponse => ({ status: 'success', id: '1' })

const noteSchemas = contractSchemas(notes, {
    create: { body: NoteInputSchema, response: NoteResponseSchema },
    list: { query: NoteQuerySchema, response: NoteResponseSchema },
    remove: { response: NoteResponseSchema },
})
const defineRoute = contractRouteDefiner(noteSchemas)

describe('contractSchemas', () => {
    // feat-186: a second contract with the same method and path would overwrite the first entry.
    it('refuses two contracts of a group with one method and path', () => {
        const twice = {
            list: contract<undefined, undefined, NoteResponse>()('get', '/notes'),
            again: contract<undefined, undefined, NoteResponse>()('get', '/notes'),
        }
        expect(() =>
            contractSchemas(twice, {
                list: { response: NoteResponseSchema },
                again: { response: NoteResponseSchema },
            }),
        ).toThrow('Route contract get /notes is declared twice')
    })

    it('refuses two groups that share a method and path when they are merged', () => {
        const other = contractSchemas(
            { list: contract<undefined, undefined, NoteResponse>()('get', '/notes') },
            { list: { response: NoteResponseSchema } },
        )
        expect(() => mergeContractSchemas(noteSchemas, other)).toThrow(
            'Route contract get /notes is declared twice',
        )
        const merged = mergeContractSchemas(noteSchemas, {})
        expect(Object.keys(merged).sort()).toEqual(Object.keys(noteSchemas).sort())
    })

    it('keys the entries by the method and the path of their contracts', () => {
        expect(Object.keys(noteSchemas).sort()).toEqual([
            'delete /notes/:noteId',
            'get /notes',
            'post /notes',
        ])
        expect(noteSchemas['post /notes'].body).toBe(NoteInputSchema)
    })
})

describe('defineRoute', () => {
    it('takes the method and the path from the contract and the schemas from the registry', () => {
        const route = defineRoute({
            contract: notes.create,
            handler: answer,
            middlewares: ['auth_guard'],
        })

        expect(route).toMatchObject({
            url: '/notes',
            method: 'post',
            contractPath: '/notes',
            middlewares: ['auth_guard'],
            ResponseSchema: NoteResponseSchema,
        })
        expect(route.validator).toBeDefined()
        expect(route.queryValidator).toBeUndefined()
        expect('contract' in route).toBe(false)
    })

    it('wraps the query schema of a contract with a query', () => {
        const route = defineRoute({ contract: notes.list, handler: answer })

        expect(route.queryValidator).toBeDefined()
        expect(route.validator).toBeUndefined()
    })

    it('refuses at start a contract that has no entry in the registry', () => {
        const unknown = contract<undefined, undefined, NoteResponse>()('get', '/elsewhere')
        const define = defineRoute as (config: unknown) => unknown

        expect(() => define({ contract: unknown, handler: answer })).toThrow(
            'Route contract get /elsewhere has no entry in the schema registry',
        )
    })
})

// feat-177: a multipart contract checks its text fields against the body schema and accepts only
// multipart; a navigation contract is a GET route like any other on the server.
describe('multipart and navigation contracts', () => {
    const EmptyFieldsSchema = type({ '+': 'reject' })
    const files = {
        upload: multipartContract<typeof EmptyFieldsSchema.inferIn, 'picture', NoteResponse>()(
            'post',
            '/notes/:noteId/picture',
        ),
        picture: navigationContract<undefined, NoteResponse>()('/notes/:noteId/picture'),
    }
    const fileSchemas = contractSchemas(files, {
        upload: { body: EmptyFieldsSchema, response: NoteResponseSchema },
        picture: { response: NoteResponseSchema },
    })
    const defineFileRoute = contractRouteDefiner(fileSchemas)

    it('a multipart route accepts multipart only and validates its fields', () => {
        const route = defineFileRoute({ contract: files.upload, handler: answer })

        expect(route).toMatchObject({
            url: '/notes/:noteId/picture',
            method: 'post',
            allowedContentTypes: ['multipart'],
        })
        expect(route.validator).toBeDefined()
    })

    it('a navigation route is a plain GET with its response schema', () => {
        const route = defineFileRoute({ contract: files.picture, handler: answer })

        expect(route).toMatchObject({ url: '/notes/:noteId/picture', method: 'get' })
        expect(route.allowedContentTypes).toBeUndefined()
        expect(route.ResponseSchema).toBe(NoteResponseSchema)
    })

    // Compiled, never run.
    function multipartTypeChecks(): void {
        contractSchemas(files, {
            // @ts-expect-error — the fields schema of a multipart contract is checked too
            upload: { body: NoteInputSchema, response: NoteResponseSchema },
            picture: { response: NoteResponseSchema },
        })
    }

    it('compiles its type checks', () => {
        expect(multipartTypeChecks).toBeTypeOf('function')
    })
})

describe('a contract route in the route table', () => {
    const remove = defineRoute({ contract: notes.remove, handler: answer })

    it('gets its URL from the contract, inside the group that has its prefix', () => {
        const [route] = routesHandler([{ group: [remove], prefix: 'notes', middlewares: ['a'] }])

        expect(route?.url).toBe(`${appConfig.pathPrefix}/notes/:noteId`)
        expect(route?.method).toBe('del')
        expect(route?.parametersKey).toEqual(['noteId'])
        expect(route?.middlewares).toEqual(['a'])
    })

    it('works in nested groups and without a group', () => {
        const nested = routesHandler([
            { group: [{ group: [remove], prefix: '' }], prefix: 'notes' },
        ])
        const bare = routesHandler([remove])

        expect(nested[0]?.url).toBe(`${appConfig.pathPrefix}/notes/:noteId`)
        expect(bare[0]?.url).toBe(`${appConfig.pathPrefix}/notes/:noteId`)
    })

    it('refuses a contract placed in the group of another prefix', () => {
        expect(() => routesHandler([{ group: [remove], prefix: 'admin' }])).toThrow(
            'Route contract /notes/:noteId is declared in the route group "/admin"',
        )
        // A prefix that only looks alike is another prefix.
        expect(() => routesHandler([{ group: [remove], prefix: 'note' }])).toThrow(
            'the path of a contract has to start with the prefix of its group',
        )
    })
})

// Checked by the compiler, never run: an entry that is not its contract's does not compile, and
// neither does a route whose contract has no entry.
function typeChecks(): void {
    const OtherInputSchema = type({ title: 'string' })
    const OtherResponseSchema = type.or(
        { status: "'success'", name: 'string' },
        CanonicalErrorResponseSchema,
    )

    contractSchemas(notes, {
        // @ts-expect-error — the body schema of another route
        create: { body: OtherInputSchema, response: NoteResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    contractSchemas(notes, {
        // @ts-expect-error — the contract has a body, the entry needs its schema
        create: { response: NoteResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
        // @ts-expect-error — the contract has no body
        remove: { body: NoteInputSchema, response: NoteResponseSchema },
    })

    contractSchemas(notes, {
        // @ts-expect-error — the response schema of another route
        create: { body: NoteInputSchema, response: OtherResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        // @ts-expect-error — the query schema has other keys than the contract's query
        list: { query: type({ 'page?': 'string' }), response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        list: {
            // @ts-expect-error — the keys agree, but the schema hands `limit` over as text, while
            // the contract lets a client send a number (feat-183)
            query: type({ 'limit?': 'string', 'tag?': 'string' }),
            response: NoteResponseSchema,
        },
        remove: { response: NoteResponseSchema },
    })

    contractSchemas(
        {
            list: contract<undefined, { limit: number | string; tag?: string }, NoteResponse>()(
                'get',
                '/notes',
            ),
        },
        {
            // @ts-expect-error — a client may leave `limit` out of this schema, while the
            // contract requires it (feat-183)
            list: { query: NoteQuerySchema, response: NoteResponseSchema },
        },
    )

    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        // @ts-expect-error — the contract has a query, the entry needs its schema
        list: { response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    // @ts-expect-error — a contract of the group has no entry
    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
    })

    defineRoute({
        // @ts-expect-error — the contract has no entry in the registry
        contract: contract<undefined, undefined, NoteResponse>()('get', '/elsewhere'),
        handler: answer,
    })

    defineRoute({
        contract: notes.create,
        // @ts-expect-error — the handler answers something the response schema does not allow
        handler: () => ({ status: 'success' as const, id: 7 }),
    })

    defineRoute({
        contract: notes.create,
        // The payload is what the body schema of the entry hands over.
        handler: (context) => {
            const text: string = context.httpData.payload?.text ?? ''
            // @ts-expect-error — the payload has no such field
            const missing: unknown = context.httpData.payload?.title
            return { status: 'success' as const, id: `${text}${String(missing)}` }
        },
    })

    defineRoute({
        contract: notes.list,
        // The query is what the query schema of the entry hands over.
        handler: (context) => {
            const limit: number | undefined = context.httpData.query.limit
            return { status: 'success' as const, id: String(limit) }
        },
    })
}

describe('the compile-time checks above', () => {
    it('are compiled with the spec (the function is never called)', () => {
        expect(typeChecks).toBeTypeOf('function')
    })
})

// feat-181 (ADR 0006): a WS route through its contract. The event comes from the contract, the
// payload and reply schemas from the registry entry keyed `ws <event>`.
describe('defineWsRoute through a WS contract', () => {
    const MessageSchema = type({ text: '1 <= string <= 200', '+': 'reject' })
    const ws = {
        say: wsContract<typeof MessageSchema.inferIn, NoteResponse>()('/notes/say'),
        ping: wsContract<undefined, NoteResponse>()('/notes/ping'),
    }
    const wsSchemas = contractSchemas(ws, {
        say: { body: MessageSchema, response: NoteResponseSchema },
        ping: { response: NoteResponseSchema },
    })
    const defineWsRoute = contractWsRouteDefiner({ ...wsSchemas, ...noteSchemas })

    it('keys the entries `ws <event>`, apart from HTTP routes', () => {
        expect(Object.keys(wsSchemas).sort()).toEqual(['ws /notes/ping', 'ws /notes/say'])
    })

    it('takes the event from the contract and the schemas from the registry', () => {
        const route = defineWsRoute({ contract: ws.say, handler: answer, middlewares: ['a'] })

        expect(route).toMatchObject({
            url: '/notes/say',
            method: 'ws',
            contractPath: '/notes/say',
            middlewares: ['a'],
            ResponseSchema: NoteResponseSchema,
        })
        expect(route.validator).toBeDefined()
        expect(defineWsRoute({ contract: ws.ping, handler: answer }).validator).toBeUndefined()
    })

    it('refuses at start an HTTP contract', () => {
        const define = defineWsRoute as (config: unknown) => unknown
        expect(() => define({ contract: notes.create, handler: answer })).toThrow(
            'Route contract post /notes is not a WS contract',
        )
    })

    it('gets its event inside the group that has its prefix', () => {
        const route = defineWsRoute({ contract: ws.ping, handler: answer })
        const [normalized] = routesHandler([{ group: [route], prefix: 'notes' }])
        expect(normalized?.url).toBe(`${appConfig.pathPrefix}/notes/ping`)
        expect(() => routesHandler([{ group: [route], prefix: 'admin' }])).toThrow(
            'the path of a contract has to start with the prefix of its group',
        )
    })

    // Compiled, never run.
    function wsTypeChecks(): void {
        contractSchemas(ws, {
            // @ts-expect-error — the payload schema of another event
            say: { body: type({ title: 'string' }), response: NoteResponseSchema },
            ping: { response: NoteResponseSchema },
        })

        defineWsRoute({
            // @ts-expect-error — an HTTP contract is not a WS route
            contract: notes.create,
            handler: answer,
        })

        defineWsRoute({
            contract: ws.say,
            // The payload is what the registry entry's schema hands over.
            handler: (context) => {
                const payload = getTypedPayload(context)
                const text: string = payload.text
                // @ts-expect-error — the payload has no such field
                const missing: unknown = payload.title
                return { status: 'success' as const, id: `${text}${String(missing)}` }
            },
        })
    }

    it('compiles its type checks', () => {
        expect(wsTypeChecks).toBeTypeOf('function')
    })
})
