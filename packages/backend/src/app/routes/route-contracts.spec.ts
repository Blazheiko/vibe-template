import { describe, expect, it, vi } from 'vitest'

import type { RouteItem } from '#vendor/types/types.js'

// feat-170 (docs/adr/0005-route-contracts.md, target state): a route of the application is
// declared through its contract and nothing else. A route added with `defineRawRoute` (or by
// hand) has no contract path and no registry entry, and this test names it.

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
    },
}))
// The real route list imports every controller; keep the data layer offline.
vi.mock('#database/db.js', () => ({ db: {}, pool: {} }))
vi.mock('#database/redis.js', () => ({ default: {}, redisHealth: {}, withRedis: vi.fn() }))
vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { default: httpRoutes } = await import('./http-routes.js')
const { contractSchemaRegistry } = await import('./contract-schemas/index.js')
const { defineRawRoute } = await import('#app/routing/define-raw-route.js')

const BODY_METHODS = new Set(['post', 'put', 'patch'])
const registry: Readonly<Record<string, unknown>> = contractSchemaRegistry

/** The routes of a route list, groups opened (the router does not keep `contractPath`). */
const flatten = (routes: readonly unknown[]): RouteItem[] =>
    routes.flatMap((item) =>
        typeof item === 'object' && item !== null && 'group' in item
            ? flatten((item as { group: readonly unknown[] }).group)
            : [item as RouteItem],
    )

const keyOf = (route: RouteItem): string => `${route.method} ${String(route.contractPath)}`

/** What is wrong with each route of a route list, as `METHOD url: reason`. */
const contractProblems = (routes: readonly unknown[]): string[] =>
    flatten(routes).flatMap((route) => {
        const name = `${route.method.toUpperCase()} ${route.url}`
        if (route.contractPath === undefined) return [`${name}: declared without a contract`]
        const problems: string[] = []
        if (!(keyOf(route) in registry)) problems.push(`${name}: no registry entry`)
        if (BODY_METHODS.has(route.method) && route.validator === undefined) {
            problems.push(`${name}: a body method without a body schema`)
        }
        if (route.ResponseSchema === undefined) problems.push(`${name}: no response schema`)
        return problems
    })

describe('every route of the application has a contract', () => {
    it('http-routes.ts: a contract, a registry entry, a body schema where there is a body', () => {
        expect(contractProblems(httpRoutes)).toEqual([])
    })

    it('the registry has no entry without a route', () => {
        const declared = new Set(flatten(httpRoutes).map(keyOf))
        expect(Object.keys(registry).filter((key) => !declared.has(key))).toEqual([])
    })

    it('names a route added without a contract', () => {
        const raw = defineRawRoute({
            url: '/notes',
            method: 'get',
            handler: () => ({ status: 'ok' }),
        })

        expect(contractProblems([...httpRoutes, { group: [raw], prefix: 'main' }])).toEqual([
            'GET /notes: declared without a contract',
        ])
    })
})
