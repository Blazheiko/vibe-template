import { type } from '@arktype/type'
import { describe, expect, it, vi } from 'vitest'
import { contract } from 'shared/contracts'
import { CanonicalErrorResponseSchema } from 'shared/responses'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { contractRouteDefiner, contractSchemas } = await import('./contract-registry.js')
const { routesHandler } = await import('#vendor/start/router.js')
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
const defineContractRoute = contractRouteDefiner(noteSchemas)

describe('contractSchemas', () => {
    it('keys the entries by the method and the path of their contracts', () => {
        expect(Object.keys(noteSchemas).sort()).toEqual([
            'delete /notes/:noteId',
            'get /notes',
            'post /notes',
        ])
        expect(noteSchemas['post /notes'].body).toBe(NoteInputSchema)
    })
})

describe('defineContractRoute', () => {
    it('takes the method and the path from the contract and the schemas from the registry', () => {
        const route = defineContractRoute({
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
        const route = defineContractRoute({ contract: notes.list, handler: answer })

        expect(route.queryValidator).toBeDefined()
        expect(route.validator).toBeUndefined()
    })

    it('refuses at start a contract that has no entry in the registry', () => {
        const unknown = contract<undefined, undefined, NoteResponse>()('get', '/elsewhere')
        const define = defineContractRoute as (config: unknown) => unknown

        expect(() => define({ contract: unknown, handler: answer })).toThrow(
            'Route contract get /elsewhere has no entry in the schema registry',
        )
    })
})

describe('a contract route in the route table', () => {
    const remove = defineContractRoute({ contract: notes.remove, handler: answer })

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
        // @ts-expect-error — the contract has a query, the entry needs its schema
        list: { response: NoteResponseSchema },
        remove: { response: NoteResponseSchema },
    })

    // @ts-expect-error — a contract of the group has no entry
    contractSchemas(notes, {
        create: { body: NoteInputSchema, response: NoteResponseSchema },
        list: { query: NoteQuerySchema, response: NoteResponseSchema },
    })

    defineContractRoute({
        // @ts-expect-error — the contract has no entry in the registry
        contract: contract<undefined, undefined, NoteResponse>()('get', '/elsewhere'),
        handler: answer,
    })

    defineContractRoute({
        contract: notes.create,
        // @ts-expect-error — the handler answers something the response schema does not allow
        handler: () => ({ status: 'success' as const, id: 7 }),
    })

    defineContractRoute({
        contract: notes.create,
        // The payload is what the body schema of the entry hands over.
        handler: (context) => {
            const text: string = context.httpData.payload?.text ?? ''
            // @ts-expect-error — the payload has no such field
            const missing: unknown = context.httpData.payload?.title
            return { status: 'success' as const, id: `${text}${String(missing)}` }
        },
    })

    defineContractRoute({
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
