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

const { defineContractRoute } = await import('./define-route.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { default: appConfig } = await import('#config/app.js')

// docs/adr/0005-route-contracts.md: a route declared through a contract takes its method and
// path from it, and its schemas are checked against the contract's types by the compiler.

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

describe('defineContractRoute', () => {
    it('takes the method and the path from the contract and wraps the schemas', () => {
        const route = defineContractRoute({
            contract: notes.create,
            validator: NoteInputSchema,
            ResponseSchema: NoteResponseSchema,
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
        const route = defineContractRoute({
            contract: notes.list,
            queryValidator: NoteQuerySchema,
            ResponseSchema: NoteResponseSchema,
            handler: answer,
        })

        expect(route.queryValidator).toBeDefined()
        expect(route.validator).toBeUndefined()
    })
})

describe('a contract route in the route table', () => {
    const remove = defineContractRoute({
        contract: notes.remove,
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

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

// Checked by the compiler, never run: a schema that is not the contract's does not compile.
function typeChecks(): void {
    const OtherInputSchema = type({ title: 'string' })
    const OtherResponseSchema = type.or(
        { status: "'success'", name: 'string' },
        CanonicalErrorResponseSchema,
    )

    defineContractRoute({
        contract: notes.create,
        // @ts-expect-error — the body schema of another route
        validator: OtherInputSchema,
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

    // @ts-expect-error — the contract has a body, the route needs its schema
    defineContractRoute({
        contract: notes.create,
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

    defineContractRoute({
        contract: notes.remove,
        // @ts-expect-error — the contract has no body
        validator: NoteInputSchema,
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

    defineContractRoute({
        contract: notes.create,
        validator: NoteInputSchema,
        // @ts-expect-error — the response schema of another route
        ResponseSchema: OtherResponseSchema,
        handler: () => ({ status: 'success' as const, name: 'x' }),
    })

    defineContractRoute({
        contract: notes.list,
        // @ts-expect-error — the query schema has other keys than the contract's query
        queryValidator: type({ 'page?': 'string' }),
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

    // @ts-expect-error — the contract has a query, the route needs its schema
    defineContractRoute({
        contract: notes.list,
        ResponseSchema: NoteResponseSchema,
        handler: answer,
    })

    defineContractRoute({
        contract: notes.create,
        validator: NoteInputSchema,
        ResponseSchema: NoteResponseSchema,
        // @ts-expect-error — the handler answers something the response schema does not allow
        handler: () => ({ status: 'success' as const, id: 7 }),
    })

    defineContractRoute({
        contract: notes.create,
        validator: NoteInputSchema,
        ResponseSchema: NoteResponseSchema,
        // The payload is what the schema hands over.
        handler: (context) => {
            const text: string = context.httpData.payload?.text ?? ''
            // @ts-expect-error — the payload has no such field
            const missing: unknown = context.httpData.payload?.title
            return { status: 'success' as const, id: `${text}${String(missing)}` }
        },
    })
}

describe('the compile-time checks above', () => {
    it('are compiled with the spec (the function is never called)', () => {
        expect(typeChecks).toBeTypeOf('function')
    })
})
