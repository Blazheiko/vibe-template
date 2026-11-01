import { type } from '@arktype/type'
import { describe, expect, it } from 'vitest'

import { defineRoute } from '#app/routing/define-route.js'
import { LoginInputSchema } from 'shared/schemas'
import { CanonicalErrorResponseSchema } from 'shared/responses'
import { defineWsRoute } from '#app/routing/define-ws-route.js'
import appConfig from '#config/app.js'
import { serializeRoutes } from './serialize-routes.js'

interface JsonSchemaForTest {
    anyOf?: JsonSchemaForTest[]
    properties?: Record<string, unknown>
    required?: string[]
}

interface SerializedSchemaForTest {
    expression?: unknown
    fields?: unknown[]
    jsonSchema?: JsonSchemaForTest
}

function getSerializedSchema(
    route: Record<string, unknown>,
    key: 'inputSchema' | 'outputSchema',
): SerializedSchemaForTest {
    const schema = route[key] as SerializedSchemaForTest | undefined
    expect(schema).toBeDefined()
    return schema!
}

describe('serializeRoutes', () => {
    it('extracts inputSchema through validator.describe()', () => {
        const schema = type({
            email: 'string.email',
        })

        const routes = [
            defineRoute({
                url: '/login',
                method: 'post',
                validator: schema,
                handler: () => ({ ok: true }),
            }),
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()

        expect(result?.['validator']).toBeUndefined()
        expect(result?.['handler']).toBeNull()
        expect(result?.['inputSchema']).toMatchObject({
            expression: expect.any(String),
            fields: expect.any(Array),
            jsonSchema: expect.objectContaining({
                type: 'object',
                properties: expect.any(Object),
            }),
        })
    })

    it('serializes union request schemas through JSON Schema anyOf', () => {
        const routes = [
            defineRoute({
                url: '/login',
                method: 'post',
                validator: LoginInputSchema,
                handler: () => ({ ok: true }),
            }),
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()

        const inputSchema = getSerializedSchema(result!, 'inputSchema')
        expect(inputSchema.expression).toEqual(expect.any(String))
        expect(inputSchema.fields).toHaveLength(0)
        expect(inputSchema.jsonSchema?.anyOf).toHaveLength(2)

        const branchProperties =
            inputSchema.jsonSchema?.anyOf?.map((branch) => Object.keys(branch.properties ?? {})) ??
            []

        expect(branchProperties.some((keys) => keys.includes('email'))).toBe(true)
        expect(branchProperties.some((keys) => keys.includes('identifier'))).toBe(true)
    })

    it('serializes union response schemas through JSON Schema anyOf', () => {
        const successSchema = type({
            status: "'success'",
            message: 'string',
        })

        const routes = [
            defineRoute({
                url: '/register',
                method: 'post',
                ResponseSchema: type.or(successSchema, CanonicalErrorResponseSchema),
                handler: () => ({ status: 'success' as const, message: 'ok' }),
            }),
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()

        const outputSchema = getSerializedSchema(result!, 'outputSchema')
        expect(outputSchema.expression).toEqual(expect.any(String))
        expect(outputSchema.fields).toHaveLength(0)
        expect(outputSchema.jsonSchema?.anyOf).toHaveLength(2)

        const statusSchemas =
            outputSchema.jsonSchema?.anyOf?.map(
                (branch) => branch.properties?.['status'] as { const?: unknown } | undefined,
            ) ?? []

        expect(statusSchemas).toContainEqual(expect.objectContaining({ const: 'success' }))
        expect(statusSchemas).toContainEqual(expect.objectContaining({ const: 'error' }))
    })

    it('keeps non-union response schema fields', () => {
        const responseSchema = type({
            status: "'ok'",
            message: 'string',
        })

        const routes = [
            defineRoute({
                url: '/ping',
                method: 'get',
                ResponseSchema: responseSchema,
                handler: () => ({ status: 'ok' as const, message: 'ok' }),
            }),
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()

        const outputSchema = getSerializedSchema(result!, 'outputSchema')
        expect(outputSchema.fields).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'status', required: true }),
                expect.objectContaining({ name: 'message', required: true }),
            ]),
        )
    })

    it('omits inputSchema when validator is absent', () => {
        const routes = [
            defineRoute({
                url: '/ping',
                method: 'get',
                handler: () => ({ ok: true }),
            }),
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()

        expect(result?.['inputSchema']).toBeUndefined()
    })

    it('omits inputSchema for validators with non-ArkType describe() output', () => {
        const routes = [
            {
                url: '/native',
                method: 'post',
                handler: () => ({ ok: true }),
                validator: {
                    validate: () => ({ ok: true, value: { ok: true } }),
                    describe: () => ({ kind: 'predicate' }),
                },
            },
        ]

        const [result] = serializeRoutes(routes) as Record<string, unknown>[]
        expect(result).toBeDefined()
        expect(result?.['inputSchema']).toBeUndefined()
    })

    it('omits inputSchema when describe() returns nothing usable', () => {
        const routes = [null, 'schema', ['a'], { fields: [] }].map((described) => ({
            url: '/native',
            method: 'post',
            handler: () => ({ ok: true }),
            validator: {
                validate: () => ({ ok: true, value: {} }),
                describe: () => described,
            },
        }))

        for (const result of serializeRoutes(routes) as Record<string, unknown>[]) {
            expect(result['inputSchema']).toBeUndefined()
        }
    })
})

const nativeRoute = (key: 'validator' | 'queryValidator', described: unknown) => ({
    url: '/native',
    method: 'post',
    handler: () => ({ ok: true }),
    [key]: {
        validate: () => ({ ok: true, value: {} }),
        describe: () => described,
    },
})

describe('serializeRoutes with non-ArkType describe()', () => {
    it('passes a ready descriptor through, dropping malformed fields', () => {
        const jsonSchema = { type: 'object' }
        const [result] = serializeRoutes([
            nativeRoute('validator', {
                expression: '{ name: string }',
                fields: [
                    { name: 'name', type: 'string', required: true },
                    { name: 'broken', type: 1 },
                    'junk',
                ],
                jsonSchema,
            }),
        ]) as Record<string, unknown>[]

        expect(result?.['inputSchema']).toEqual({
            expression: '{ name: string }',
            fields: [{ name: 'name', type: 'string', required: true }],
            jsonSchema,
        })
    })

    it('gives a descriptor without fields an empty list', () => {
        const [result] = serializeRoutes([
            nativeRoute('validator', { expression: 'custom' }),
        ]) as Record<string, unknown>[]

        expect(result?.['inputSchema']).toEqual({ expression: 'custom', fields: [] })
    })

    it('reads a plain JSON Schema object', () => {
        const jsonSchema = {
            type: 'object',
            properties: {
                email: { type: 'string', format: 'email' },
                age: { type: ['integer', 'null'] },
                role: { enum: ['admin', 'user'] },
                kind: { const: 'person' },
                meta: {},
            },
            required: ['email', 'kind'],
        }
        const [result] = serializeRoutes([nativeRoute('validator', jsonSchema)]) as Record<
            string,
            unknown
        >[]

        expect(result?.['inputSchema']).toEqual({
            expression: 'object',
            fields: [
                { name: 'email', type: 'string', required: true },
                { name: 'age', type: 'integer | null', required: false },
                { name: 'role', type: '"admin" | "user"', required: false },
                { name: 'kind', type: '"person"', required: true },
                { name: 'meta', type: 'unknown', required: false },
            ],
            jsonSchema,
        })
    })

    it('keeps a JSON Schema union in jsonSchema with no top-level fields', () => {
        const jsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] }
        const [result] = serializeRoutes([nativeRoute('validator', jsonSchema)]) as Record<
            string,
            unknown
        >[]

        expect(result?.['inputSchema']).toEqual({ expression: 'unknown', fields: [], jsonSchema })
    })

    it('serializes a non-ArkType query validator into querySchema', () => {
        const [result] = serializeRoutes([
            nativeRoute('queryValidator', {
                type: 'object',
                properties: { page: { type: 'integer' } },
            }),
        ]) as Record<string, unknown>[]

        expect(result?.['querySchema']).toMatchObject({
            fields: [{ name: 'page', type: 'integer', required: false }],
        })
        expect(result?.['queryValidator']).toBeUndefined()
    })
})

describe('serializeRoutes bodyLimits', () => {
    const handler = () => ({})
    const json = { kind: 'json', maxBytes: appConfig.maxJsonBodySize }
    const multipart = { kind: 'multipart', maxBytes: appConfig.maxMultipartBodySize }
    const bodyLimitsOf = (route: unknown): unknown =>
        (serializeRoutes([route])[0] as Record<string, unknown>)['bodyLimits']

    it.each(['post', 'put', 'patch'] as const)(
        '%s without allowedContentTypes → the JSON limit',
        (method) => {
            expect(bodyLimitsOf(defineRoute({ url: '/x', method, handler }))).toEqual([json])
        },
    )

    it('lists each allowed type in order', () => {
        expect(
            bodyLimitsOf(
                defineRoute({
                    url: '/x',
                    method: 'post',
                    allowedContentTypes: ['multipart'],
                    handler,
                }),
            ),
        ).toEqual([multipart])
        expect(
            bodyLimitsOf(
                defineRoute({
                    url: '/x',
                    method: 'post',
                    allowedContentTypes: ['json', 'multipart'],
                    handler,
                }),
            ),
        ).toEqual([json, multipart])
    })

    it('shows the route maxBodySize where it tightens the limit, and never above the global one', () => {
        const tight = bodyLimitsOf(
            defineRoute({
                url: '/x',
                method: 'post',
                allowedContentTypes: ['json', 'multipart'],
                maxBodySize: 1234,
                handler,
            }),
        )
        const loose = bodyLimitsOf(
            defineRoute({
                url: '/x',
                method: 'post',
                allowedContentTypes: ['multipart'],
                maxBodySize: appConfig.maxMultipartBodySize * 2,
                handler,
            }),
        )

        expect(tight).toEqual([
            { kind: 'json', maxBytes: 1234 },
            { kind: 'multipart', maxBytes: 1234 },
        ])
        expect(loose).toEqual([multipart])
    })

    it('allowedContentTypes: [] → an empty list', () => {
        expect(
            bodyLimitsOf(
                defineRoute({ url: '/x', method: 'post', allowedContentTypes: [], handler }),
            ),
        ).toEqual([])
    })

    it.each(['get', 'delete'] as const)('%s has no bodyLimits', (method) => {
        expect(bodyLimitsOf(defineRoute({ url: '/x', method, handler }))).toBeUndefined()
    })

    it('a WS route has no bodyLimits', () => {
        expect(bodyLimitsOf(defineWsRoute({ url: 'x', handler }))).toBeUndefined()
    })

    it('is set on routes inside nested groups', () => {
        const [group] = serializeRoutes([
            { group: [{ group: [defineRoute({ url: '/x', method: 'patch', handler })] }] },
        ]) as { group: { group: Record<string, unknown>[] }[] }[]

        expect(group?.group[0]?.group[0]?.['bodyLimits']).toEqual([json])
    })
})
