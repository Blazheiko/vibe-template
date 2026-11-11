import { type } from '@arktype/type'
import { describe, expect, it } from 'vitest'

import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { badRequest } from '#app/services/shared/errors.js'
import { CanonicalErrorResponseSchema } from 'shared/responses'

import { defineRawRoute } from './define-raw-route.js'
import { defineWsRoute } from './define-ws-route.js'

describe('defineRawRoute', () => {
    it('wraps the input schema with the default validator', () => {
        const schema = type({
            email: 'string.email',
        })

        const route = defineRawRoute({
            url: '/login',
            method: 'post',
            validator: schema,
            handler: () => ({ ok: true }),
        })

        expect(route.validator).toBeDefined()
        expect(route.validator?.describe?.()).toBe(schema)
        expect(route.validator?.validate({ email: 'user@example.com' })).toEqual({
            ok: true,
            value: { email: 'user@example.com' },
        })
    })

    it('leaves validator undefined when route has no schema', () => {
        const route = defineRawRoute({
            url: '/ping',
            method: 'get',
            handler: () => ({ ok: true }),
        })

        expect(route.validator).toBeUndefined()
    })

    it('wraps queryValidator in strict mode by default', () => {
        const schema = type({
            page: 'string.integer.parse',
        })

        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: schema,
            handler: () => ({ ok: true }),
        })

        expect(route.queryValidator).toBeDefined()
        expect(route.queryValidator?.validate({ page: '1' })).toEqual({
            ok: true,
            value: { page: 1 },
        })
        expect(route.queryValidator?.validate({ page: '1', extra: 'x' })).toMatchObject({
            ok: false,
        })
    })

    it('supports queryAllowExtra as loose plus strip', () => {
        const schema = type({
            page: 'string.integer.parse',
        })

        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: schema,
            queryAllowExtra: true,
            handler: () => ({ ok: true }),
        })

        expect(route.queryValidator?.validate({ page: '1', extra: 'x' })).toEqual({
            ok: true,
            value: { page: 1 },
        })
    })
})

describe('defineRawRoute body validator typing', () => {
    const schema = type({ id: 'string' })

    it('allows a body validator on post/put/patch', () => {
        for (const method of ['post', 'put', 'patch'] as const) {
            expect(
                defineRawRoute({
                    url: '/items',
                    method,
                    validator: schema,
                    handler: () => ({}),
                }).validator,
            ).toBeDefined()
        }
    })

    it('rejects a body validator on get/delete/del at the type level', () => {
        // Runtime would throw in routesHandler; here only the type error matters.
        // @ts-expect-error get never reads a body
        defineRawRoute({
            url: '/items',
            method: 'get',
            validator: schema,
            handler: () => ({}),
        })
        // @ts-expect-error delete never reads a body
        defineRawRoute({
            url: '/items',
            method: 'delete',
            validator: schema,
            handler: () => ({}),
        })
        // @ts-expect-error del never reads a body
        defineRawRoute({
            url: '/items',
            method: 'del',
            validator: schema,
            handler: () => ({}),
        })
        expect(true).toBe(true)
    })

    it('accepts only methods registerHttpRoute can register', () => {
        // @ts-expect-error ws routes go through defineWsRoute
        defineRawRoute({ url: '/items', method: 'ws', handler: () => ({}) })
        // @ts-expect-error options is answered by the CORS preflight handler
        defineRawRoute({ url: '/items', method: 'options', handler: () => ({}) })
        expect(true).toBe(true)
    })
})

describe('defineWsRoute', () => {
    it('wraps websocket route schemas through the same validator wrapper', () => {
        const schema = type({
            roomId: 'string',
        })

        const route = defineWsRoute({
            url: 'join_room',
            validator: schema,
            handler: () => ({ ok: true }),
        })

        expect(route.method).toBe('ws')
        expect(route.validator?.describe?.()).toBe(schema)
    })
})

// Type-level checks: each `@ts-expect-error` must hit a real error, so `pnpm typecheck`
// fails if the handler result stops being checked against the route's ResponseSchema.
describe('defineRawRoute response typing', () => {
    const OkSchema = type({ status: "'ok'" })
    const ReadySchema = type({ ready: 'boolean' })
    const OkOrErrorSchema = type.or(OkSchema, CanonicalErrorResponseSchema)
    const ok = (): { status: 'ok' } => ({ status: 'ok' })

    it('rejects a handler result that does not match ResponseSchema', () => {
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkSchema,
            // @ts-expect-error 'fail' is not 'ok'
            handler: () => ({ status: 'fail' as const }),
        })
        expect(true).toBe(true)
    })

    it('rejects an annotated handler declared with a foreign schema', () => {
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: ReadySchema,
            // @ts-expect-error { status: 'ok' } has no `ready`
            handler: ok,
        })
        expect(true).toBe(true)
    })

    it('accepts any Payload when the route has no ResponseSchema', () => {
        defineRawRoute({ url: '/items', method: 'get', handler: () => 'text' })
        defineRawRoute({ url: '/items', method: 'get', handler: () => ({ anything: 1 }) })
        expect(true).toBe(true)
    })

    it('accepts a sync and an async result', () => {
        defineRawRoute({ url: '/a', method: 'get', ResponseSchema: OkSchema, handler: ok })
        defineRawRoute({
            url: '/b',
            method: 'get',
            ResponseSchema: OkSchema,
            handler: async () => ok(),
        })
        // Known limit: TypeScript widens a literal whose contextual type is the generic
        // `TRes['inferIn']`, so an inline handler needs `as const` like a controller does.
        defineRawRoute({
            url: '/c',
            method: 'get',
            ResponseSchema: OkSchema,
            handler: () => ({ status: 'ok' as const }),
        })
        defineRawRoute({
            url: '/d',
            method: 'get',
            ResponseSchema: OkSchema,
            // @ts-expect-error the literal widens to string without `as const`
            handler: (_context) => ({ status: 'ok' }),
        })
        expect(true).toBe(true)
    })

    it('accepts a mapControllerError result when the schema includes the error union', () => {
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkOrErrorSchema,
            handler: (context) => mapControllerError(context, badRequest('bad')),
        })
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkSchema,
            // @ts-expect-error the schema has no error branch
            handler: (context) => mapControllerError(context, badRequest('bad')),
        })
        expect(true).toBe(true)
    })

    it('accepts null only when the schema allows it', () => {
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkSchema,
            // @ts-expect-error null is not in the schema
            handler: () => null,
        })
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkSchema.or('null'),
            handler: () => null,
        })
        expect(true).toBe(true)
    })

    it('checks a bound controller method like an arrow function', () => {
        const controller = {
            prefix: 'ok',
            get(this: { prefix: string }): { status: string } {
                return { status: this.prefix }
            },
        }
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: OkSchema,
            // @ts-expect-error string is wider than 'ok'
            handler: controller.get.bind(controller),
        })
        expect(true).toBe(true)
    })

    it('still infers body and query alongside the result', () => {
        defineRawRoute({
            url: '/items',
            method: 'post',
            validator: type({ id: 'string' }),
            queryValidator: type({ page: 'string' }),
            ResponseSchema: type({ id: 'string', page: 'string' }),
            handler: ({ httpData }) => ({
                id: httpData.payload?.id ?? '',
                page: httpData.query.page,
            }),
        })
        expect(true).toBe(true)
    })

    it('checks the result against the schema input, not its morphed output', () => {
        const Morphed = type({ count: 'string.numeric.parse' })
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: Morphed,
            handler: () => ({ count: '1' }),
        })
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: Morphed,
            // @ts-expect-error the input is a string; the parsed number is the output
            handler: () => ({ count: 1 }),
        })
        expect(true).toBe(true)
    })

    it('does not check the result when ResponseSchema is Type | undefined', () => {
        // Known limit: only an exact `Type` enables the check.
        const maybe: typeof OkSchema | undefined = undefined as typeof OkSchema | undefined
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: maybe,
            handler: () => ({ anything: 1 }),
        })
        expect(true).toBe(true)
    })

    it('rejects a schema whose input is not a Payload', () => {
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: type('string[]'),
            // @ts-expect-error a top-level array is not a Payload
            handler: () => ['a'],
        })
        defineRawRoute({
            url: '/items',
            method: 'get',
            ResponseSchema: type('string[]'),
            // @ts-expect-error no object satisfies a non-Payload schema
            handler: () => ({ responseSchemaIsNotPayload: ['a'] }),
        })
        expect(true).toBe(true)
    })
})

describe('defineWsRoute response typing', () => {
    const OkSchema = type({ status: "'ok'" })

    it('checks the handler result against ResponseSchema', () => {
        defineWsRoute({
            url: 'ok',
            ResponseSchema: OkSchema,
            handler: () => ({ status: 'ok' as const }),
        })
        defineWsRoute({
            url: 'fail',
            ResponseSchema: OkSchema,
            // @ts-expect-error 'fail' is not 'ok'
            handler: () => ({ status: 'fail' as const }),
        })
        defineWsRoute({
            url: 'foreign',
            ResponseSchema: type({ ready: 'boolean' }),
            // @ts-expect-error { status: 'ok' } has no `ready`
            handler: (): { status: 'ok' } => ({ status: 'ok' }),
        })
        defineWsRoute({
            url: 'not-payload',
            ResponseSchema: type('string[]'),
            // @ts-expect-error no object satisfies a non-Payload schema
            handler: () => ({ responseSchemaIsNotPayload: ['a'] }),
        })
        defineWsRoute({ url: 'free', handler: () => ({ anything: 1 }) })
        expect(true).toBe(true)
    })
})
