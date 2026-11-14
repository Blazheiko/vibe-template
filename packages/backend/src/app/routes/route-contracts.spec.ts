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
const { default: wsRoutes } = await import('./ws-routes.js')
const { contractSchemaRegistry } = await import('./contract-schemas/index.js')
const { defineRawRoute } = await import('#app/routing/define-raw-route.js')
const { defineRawWsRoute } = await import('#app/routing/define-ws-route.js')

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

    // feat-186: a duplicate is not lost in a Set. Two contracts with one `<method> <path>` would
    // share one registry entry and one route; two routes with one key would shadow each other.
    it('every contract of shared/contracts has its own method and path, and an entry', async () => {
        const exported: unknown[] = Object.values(await import('shared/contracts'))
        const groups = exported.filter(
            // A group: an object of contracts, each `{ method, path }` at run time.
            (value): value is Record<string, { method: string; path: string }> =>
                typeof value === 'object' &&
                value !== null &&
                Object.values(value).every(
                    (item: unknown) =>
                        typeof item === 'object' &&
                        item !== null &&
                        typeof (item as { method?: unknown }).method === 'string' &&
                        typeof (item as { path?: unknown }).path === 'string',
                ),
        )
        const keys = groups.flatMap((group) =>
            Object.values(group).map((c) => `${c.method} ${c.path}`),
        )
        expect(keys.length).toBeGreaterThan(0)
        expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
        expect([...keys].sort()).toEqual(Object.keys(registry).sort())
    })

    it('no two routes share a method and path', () => {
        const keys = [...flatten(httpRoutes), ...flatten(wsRoutes)].map(keyOf)
        expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])
    })

    it('the registry has no entry without a route', () => {
        const declared = new Set([...flatten(httpRoutes), ...flatten(wsRoutes)].map(keyOf))
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

// feat-181 (ADR 0006): the same for the WS routes.
describe('every WS route of the application has a contract', () => {
    it('ws-routes.ts: a contract, a registry entry, a response schema', () => {
        expect(contractProblems(wsRoutes)).toEqual([])
    })

    it('names a WS route added without a contract', () => {
        const raw = defineRawWsRoute({ url: 'echo', handler: () => ({ status: 'ok' }) })

        expect(contractProblems([...wsRoutes, { group: [raw], prefix: 'support' }])).toEqual([
            'WS echo: declared without a contract',
        ])
    })
})
