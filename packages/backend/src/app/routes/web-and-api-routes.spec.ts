import { describe, expect, it, vi } from 'vitest'

import type { HttpContext, routeList } from '#vendor/types/types.js'

// Pins what documentation/backend/web-and-api-routes.md says about the two kinds of HTTP
// routes: web routes (session_web + csrf_guard) and public API routes (neither).

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
vi.mock('#config/csrf.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    default: {
        enforce: true,
        strictOrigin: true,
        allowedOrigins: ['https://app.example.com'],
        effectiveAllowedOrigins: ['https://app.example.com'],
        headerName: 'x-csrf-token',
    },
}))

vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { default: httpRoutes } = await import('./http-routes.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { default: executeMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')
const { default: createHttpContext } = await import('#vendor/utils/context/http-context.js')

const UNSAFE = new Set(['post', 'put', 'patch', 'delete', 'del'])
const handler = (): { ok: true } => ({ ok: true })

/** A request as the router hands it over: the default context, no session attached yet. */
const requestWithoutSession = (method: string, headers: [string, string][] = []): HttpContext =>
    createHttpContext(
        {
            method,
            ip: '203.0.113.7',
            params: {},
            payload: {},
            query: null,
            headers: new Map(headers),
            contentType: 'application/json',
            cookies: new Map(),
            isJson: true,
            files: null,
            hasFile: () => false,
        } as HttpContext['httpData'],
        {
            aborted: false,
            payload: null,
            middlewareData: {},
            headers: [],
            cookies: new Map(),
            status: 200,
            deleteCookie: vi.fn(),
            setCookie: vi.fn(),
            setHeader: vi.fn(),
        },
    )

describe('web routes in http-routes.ts', () => {
    const routes = routesHandler(httpRoutes)

    it('every route with session_web also has csrf_guard right after it', () => {
        for (const route of routes.filter((item) =>
            (item.middlewares ?? []).includes('session_web'),
        )) {
            const middlewares = route.middlewares ?? []
            expect(middlewares[0], route.url).toBe('session_web')
            expect(middlewares[1], route.url).toBe('csrf_guard')
        }
    })

    it('every route that changes data is a web route', () => {
        for (const route of routes.filter((item) => UNSAFE.has(item.method))) {
            expect(route.middlewares, `${route.method} ${route.url}`).toContain('csrf_guard')
        }
    })

    it('only the health checks are outside the web groups', () => {
        const outside = routes
            .filter((route) => !(route.middlewares ?? []).includes('session_web'))
            .map((route) => `${route.method} ${route.url}`)
        expect(outside.sort()).toEqual(['get api/ping', 'get api/ready'])
    })
})

describe('group middlewares', () => {
    const routes = routesHandler([
        {
            group: [
                { url: '/profile', method: 'post', handler, middlewares: ['auth_guard'] },
                { url: '/status', method: 'get', handler },
            ],
            prefix: 'web',
            middlewares: ['session_web', 'csrf_guard'],
        },
        {
            group: [{ url: '/orders', method: 'post', handler }],
            prefix: 'v1',
        },
    ] as routeList)

    it('a route in a web group always gets the group middlewares first', () => {
        const byUrl = new Map(routes.map((route) => [route.url, route.middlewares]))
        expect(byUrl.get('api/web/profile')).toEqual(['session_web', 'csrf_guard', 'auth_guard'])
        expect(byUrl.get('api/web/status')).toEqual(['session_web', 'csrf_guard'])
    })

    it('a route in a group without middlewares runs none', () => {
        const orders = routes.find((route) => route.url === 'api/v1/orders')
        expect(orders?.middlewares).toEqual([])
    })
})

describe('a request that did not go through session_web', () => {
    it('has no session and no user', () => {
        const context = requestWithoutSession('get')
        expect(context.session.sessionInfo).toBeNull()
        expect(context.auth.check()).toBe(false)
        expect(context.auth.getUserId()).toBeNull()
    })

    it('passes an empty middleware list straight to the handler', async () => {
        const context = requestWithoutSession('post')
        await expect(executeMiddlewares([], context)).resolves.toBe(true)
        expect(context.responseData.status).toBe(200)
    })

    it('gets 401 from auth_guard: it only reads the cookie session', async () => {
        const context = requestWithoutSession('get', [['authorization', 'Bearer some-api-key']])
        await expect(executeMiddlewares(['auth_guard'], context)).resolves.toBe(false)
        expect(context.responseData.status).toBe(401)
    })

    it('gets 403 token_mismatch from csrf_guard on POST, even from an allowed origin', async () => {
        const context = requestWithoutSession('post', [
            ['origin', 'https://app.example.com'],
            ['x-csrf-token', 'a'.repeat(43)],
        ])
        await expect(executeMiddlewares(['csrf_guard'], context)).resolves.toBe(false)
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({
            code: 'csrf_invalid',
            reason: 'token_mismatch',
        })
    })

    it('lets GET through csrf_guard: only unsafe methods are checked', async () => {
        const context = requestWithoutSession('get')
        await expect(executeMiddlewares(['csrf_guard'], context)).resolves.toBe(true)
    })
})

describe('a server-to-server client on a web route', () => {
    it('gets 403 origin_mismatch: no Origin, no Referer, CSRF_STRICT_ORIGIN=true', async () => {
        // session_web would give it an anonymous session first; the Origin check runs
        // before the token one, so the answer is the same with or without that session.
        const context = requestWithoutSession('post', [['authorization', 'Bearer some-api-key']])
        await expect(executeMiddlewares(['csrf_guard'], context)).resolves.toBe(false)
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({ reason: 'origin_mismatch' })
    })
})
