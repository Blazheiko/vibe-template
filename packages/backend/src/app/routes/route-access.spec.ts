import { describe, expect, it, vi } from 'vitest'

import { type } from '@arktype/type'

import { nonWirePaths, unknownPaths } from '#app/routes/response-schema-guards.js'
import type { HttpContext, RouteItem } from '#vendor/types/types.js'
import { BroadcastEventSchemas } from 'shared/schemas'

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
// The real route lists import every controller; keep the data layer offline.
vi.mock('#database/db.js', () => ({ db: {}, pool: {} }))
vi.mock('#database/redis.js', () => ({ default: {}, redisHealth: {}, withRedis: vi.fn() }))

// Config modules validate secrets at import time.
vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { default: httpRoutes } = await import('./http-routes.js')
const { default: wsRoutes } = await import('./ws-routes.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { createResponseCheck } = await import('#vendor/utils/validation/validate-response.js')
const { default: executeMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')

const http = routesHandler(httpRoutes)
const ws = routesHandler(wsRoutes)
const pushRoutes = http.filter((route) => route.url.includes('/push-subscriptions/'))
const isPublic = (route: RouteItem): boolean => route.url.endsWith('/vapid-public-key')

const anonymousContext = (): HttpContext =>
    ({
        auth: { check: () => false, getUserId: () => null },
        responseData: { status: 200, payload: null, headers: [], cookies: [] },
        session: null,
        httpData: { headers: new Map(), cookies: new Map(), method: 'post' },
    }) as unknown as HttpContext

describe('runtime response validation wiring (feat-044 T5)', () => {
    it('every normalized route has responseCheck set, never undefined', () => {
        for (const route of [...http, ...ws]) {
            expect(route.responseCheck, route.url).not.toBeUndefined()
        }
    })

    it('a route with a ResponseSchema gets a check, one without gets null', () => {
        for (const route of [...http, ...ws]) {
            const expected = route.ResponseSchema === undefined ? 'object' : 'function'
            expect(typeof route.responseCheck, route.url).toBe(expected)
        }
    })
})

describe('route access matrix (code-issues items 48, 67)', () => {
    it('test-push accepts only POST', () => {
        const testPush = pushRoutes.filter((route) => route.url.endsWith('/test-push'))
        expect(testPush.map((route) => route.method)).toEqual(['post'])
    })

    it('every push-subscriptions route except vapid-public-key declares auth_guard', () => {
        expect(pushRoutes.length).toBeGreaterThan(1)
        for (const route of pushRoutes) {
            expect(route.middlewares?.includes('auth_guard'), route.url).toBe(!isPublic(route))
        }
    })

    it('auth_guard answers 401 for an anonymous request before the handler', async () => {
        for (const route of pushRoutes.filter((item) => !isPublic(item))) {
            const middlewares = (route.middlewares ?? []).slice(
                (route.middlewares ?? []).indexOf('auth_guard'),
            )
            const context = anonymousContext()
            const passed = await executeMiddlewares(middlewares, context)
            expect(passed, route.url).toBe(false)
            expect(context.responseData.status, route.url).toBe(401)
        }
    })

    // feat-236 (Р4, Р6): the notification center is the signed-in user's own.
    it('every /notifications route declares session, CSRF and auth guards', () => {
        const notificationRoutes = http.filter((route) => route.url.startsWith('api/notifications'))
        expect(notificationRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
            'get api/notifications',
            'get api/notifications/preferences',
            'get api/notifications/unread-count',
            'post api/notifications/:id/read',
            'post api/notifications/read-all',
            'put api/notifications/preferences',
        ])
        for (const route of notificationRoutes) {
            for (const guard of ['session_web', 'csrf_guard', 'auth_guard']) {
                expect(route.middlewares?.includes(guard), `${route.url} ${guard}`).toBe(true)
            }
        }
    })

    // feat-235 (Р7): `?action=a&action=b` is the one key of the audit log that may repeat. Who
    // may reach each /admin route is checked by route-permissions.spec.ts (feat-240).
    it('the audit log route is a GET whose action filter may repeat', () => {
        const audit = http.find((route) => route.url === 'api/admin/audit-events')
        expect(audit?.method).toBe('get')
        expect(audit?.queryArrays).toEqual(['action'])
    })

    // feat-232: the profile of the signed-in user, read and changed with a session and CSRF.
    it('the account routes need a session, CSRF and a signed-in user', async () => {
        const accountRoutes = http.filter((route) => route.url.includes('/account/'))
        expect(accountRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
            'del api/account/sessions/:id',
            'get api/account/profile',
            'get api/account/sessions',
            'patch api/account/profile',
            'post api/account/sessions/revoke-others',
        ])
        for (const route of accountRoutes) {
            expect(route.middlewares, route.url).toEqual([
                'session_web',
                'csrf_guard',
                'auth_guard',
            ])
            const context = anonymousContext()
            const passed = await executeMiddlewares(['auth_guard'], context)
            expect(passed, route.url).toBe(false)
            expect(context.responseData.status, route.url).toBe(401)
        }
    })
})

describe('response schema guards (feat-046)', () => {
    const routesWithSchema = [...http, ...ws].filter((route) => route.ResponseSchema !== undefined)

    it('no response schema has a morph: the original object is sent after reject', () => {
        // A morph would make the sent format depend on whether undeclared keys were
        // stripped (plan §4.6, feat-047). Revisit createResponseCheck before allowing one.
        const withMorph = routesWithSchema
            .filter((route) => route.ResponseSchema?.internal.includesTransform === true)
            .map((route) => route.url)
        expect(withMorph).toEqual([])
    })

    it('no response schema has Date or bigint: it describes the JSON the client gets', () => {
        // makeJson turns bigint into a string and JSON.stringify a Date into an ISO string;
        // serialize them in a transformer and declare 'string' (feat-047 §4.1).
        const found = routesWithSchema.flatMap((route) =>
            nonWirePaths(route.ResponseSchema!).map(
                (path) => `${route.method} ${route.url}: ${path}`,
            ),
        )
        expect(found).toEqual([])
    })

    it('an unknown field is allowed only as a listed exception (plan §4.5)', () => {
        // The allow-list does not filter the content of these fields; the same list is in
        // documentation/backend/response-validation.md.
        const allowed = new Set([
            // Canonical error: built only from AppError constructors.
            'details',
            // Push log: `data` of a notification this user's device already received.
            'data.notificationLogs[].messageData',
            'data[].messageData',
        ])
        const found = routesWithSchema.flatMap((route) =>
            unknownPaths(route.ResponseSchema!)
                .filter((path) => !allowed.has(path))
                .map((path) => `${route.method} ${route.url}: ${path}`),
        )
        expect(found).toEqual([])
    })

    it('a route that can answer an error accepts the full canonical error', () => {
        // mapControllerError may add reason/details, session_web adds csrfToken: under the
        // undeclared-key check a hand-written error branch would turn them into a 500.
        // Any error branch counts, also one without `code`: it would reject or strip it.
        const probes = [
            { status: 'error' },
            { status: 'error', message: 'm' },
            { status: 'error', code: 'bad_request', message: 'm' },
        ]
        const full = {
            status: 'error',
            code: 'bad_request',
            message: 'm',
            reason: 'r',
            details: { a: 1 },
            csrfToken: 't',
        }
        const broken = routesWithSchema
            .filter((route) => {
                const reject = route.ResponseSchema!.onDeepUndeclaredKey('reject')
                const answersErrors = probes.some(
                    (probe) => !(reject(probe) instanceof type.errors),
                )
                return answersErrors && reject(full) instanceof type.errors
            })
            .map((route) => `${route.method} ${route.url}`)
        expect(broken).toEqual([])
    })

    it.each(['strict', 'log'] as const)('builds the %s check for every route', (mode) => {
        // log adds onDeepUndeclaredKey('delete'), a morph: ArkType rejects it on a union
        // with overlapping branches at start-up.
        const failed = routesWithSchema.filter((route) => {
            try {
                createResponseCheck(route.ResponseSchema, { mode })
                return false
            } catch {
                return true
            }
        })
        expect(failed.map((route) => route.url)).toEqual([])
    })

    it.each(['strict', 'log'] as const)(
        '%s keeps the canonical error of GET /auth/oauth/:provider/redirect',
        (mode) => {
            // Unknown provider → mapControllerError → 400 with `code` (reviewer P1).
            const route = http.find((item) => item.url.endsWith('auth/oauth/:provider/redirect'))
            const check = createResponseCheck(route?.ResponseSchema, { mode })
            const payload = {
                status: 'error',
                code: 'bad_request',
                message: 'Unsupported provider',
            }
            expect(check?.(payload, { route: 'oauth', transport: 'http' })).toEqual({
                ok: true,
                payload,
            })
        },
    )
})

describe('broadcast event schemas (feat-049 §4.1)', () => {
    const events = Object.entries(BroadcastEventSchemas)

    it('have no morph, Date, bigint or unknown: they describe the JSON the client gets', () => {
        const found = events.flatMap(([event, schema]) => [
            ...(schema.internal.includesTransform ? [`${event}: morph`] : []),
            ...nonWirePaths(schema).map((path) => `${event}: ${path}`),
            ...unknownPaths(schema).map((path) => `${event}: unknown ${path}`),
        ])
        expect(found).toEqual([])
    })

    it('build a check in both modes', () => {
        for (const mode of ['strict', 'log'] as const) {
            for (const [, schema] of events) {
                expect(createResponseCheck(schema, { mode })).not.toBeNull()
            }
        }
    })
})
