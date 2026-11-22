import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROLES } from 'shared/access'
import type { HttpContext, RouteItem, WsContext } from '#vendor/types/types.js'

// feat-240 (Р11): who may reach every admin route, from the real route lists. The expectations
// are the tables below, written from the plan (Р2) and not read from shared/access, so a mistake
// in the catalog cannot confirm itself.

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
vi.mock('#database/db.js', () => ({ db: {}, pool: {} }))
vi.mock('#database/redis.js', () => ({ default: {}, redisHealth: {}, withRedis: vi.fn() }))
const findRole = vi.fn()
vi.mock('#app/services/user/user-role-service.js', () => ({ userRoleService: { findRole } }))

vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { default: httpRoutes } = await import('./http-routes.js')
const { default: wsRoutes } = await import('./ws-routes.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { default: executeMiddlewares, executeWsMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')

const http = routesHandler(httpRoutes)
const ws = routesHandler(wsRoutes)

type Role = (typeof ROLES)[number]

const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
    user: [],
    support_operator: ['users.read', 'audit.read.account', 'kb.read'],
    kb_editor: ['kb.read', 'kb.write'],
    user_admin: ['users.read', 'users.roles.assign', 'audit.read', 'audit.read.account'],
    admin: [
        'kb.read',
        'kb.write',
        'kb.manage',
        'prompts.manage',
        'ai_usage.read',
        'users.read',
        'users.sensitive.read',
        'users.roles.assign',
        // feat-247: the MFA reset of another account is the admin's alone.
        'users.mfa.reset',
        'audit.read.account',
        'audit.read',
    ],
}

/** Every HTTP route under /admin and /prompts, and the permission it needs (plan Р2). */
const HTTP_ROUTE_PERMISSION: Record<string, string> = {
    'get api/admin/knowledge-base': 'kb.read',
    'get api/admin/knowledge-base/:id': 'kb.read',
    'get api/admin/knowledge-base/init-status': 'kb.read',
    'post api/admin/knowledge-base': 'kb.write',
    'put api/admin/knowledge-base/:id': 'kb.write',
    'del api/admin/knowledge-base/:id': 'kb.write',
    'post api/admin/knowledge-base/:id/screenshot': 'kb.write',
    'del api/admin/knowledge-base/:id/screenshot': 'kb.write',
    'post api/admin/knowledge-base/:id/reindex': 'kb.write',
    'post api/admin/knowledge-base/reindex-all': 'kb.manage',
    'post api/admin/knowledge-base/init': 'kb.manage',
    'get api/prompts': 'prompts.manage',
    'get api/prompts/:type': 'prompts.manage',
    'put api/prompts/:type': 'prompts.manage',
    'post api/prompts/:type/test': 'prompts.manage',
    'get api/admin/usage/text': 'ai_usage.read',
    'get api/admin/usage/stats': 'ai_usage.read',
    'get api/admin/users': 'users.read',
    'patch api/admin/users/:id/role': 'users.roles.assign',
    // feat-247: the MFA reset of another account.
    'post api/admin/users/:id/mfa/reset': 'users.mfa.reset',
    'get api/admin/users-online': 'users.read',
    'get api/admin/users-online/:id': 'users.sensitive.read',
    'get api/admin/history-online': 'users.sensitive.read',
    'get api/admin/audit-events': 'audit.read.account',
}

/** Every admin WS route and its permission; null — open to any socket (leaving the channel). */
const WS_ROUTE_PERMISSION: Record<string, string | null> = {
    'api/admin/subscribe_online_users': 'users.read',
    'api/admin/unsubscribe_online_users': null,
}

const key = (route: RouteItem): string => `${route.method} ${route.url}`
const isAdminHttp = (route: RouteItem): boolean =>
    route.url.startsWith('api/admin/') ||
    route.url === 'api/prompts' ||
    route.url.startsWith('api/prompts/')
const adminHttp = http.filter(isAdminHttp)
const adminWs = ws.filter((route) => route.url.startsWith('api/admin/'))

const httpContext = (userId: string | null): HttpContext =>
    ({
        auth: { check: () => userId !== null, getUserId: () => userId },
        responseData: { status: 200, payload: null, headers: [], cookies: [] },
        session: null,
        httpData: { headers: new Map(), cookies: new Map(), method: 'get' },
    }) as unknown as HttpContext

const wsContext = (userData: Record<string, unknown>): WsContext =>
    ({
        userData,
        responseData: { status: '200', data: null, error: null, event: 'admin/x', timestamp: 0 },
        logger: { error: vi.fn() },
        signal: new AbortController().signal,
    }) as unknown as WsContext

/** The middlewares a test may run without a real session store: from auth_guard on. */
const fromAuthGuard = (route: RouteItem): string[] => {
    const middlewares = route.middlewares ?? []
    return middlewares.slice(middlewares.indexOf('auth_guard'))
}

afterEach(() => {
    findRole.mockReset()
})

describe('HTTP access matrix (feat-240)', () => {
    it('lists exactly the admin and prompt routes of the table, the root GET /prompts included', () => {
        expect(adminHttp.map(key).sort()).toEqual(Object.keys(HTTP_ROUTE_PERMISSION).sort())
        expect(adminHttp.map(key)).toContain('get api/prompts')
    })

    it('every one runs session_web, csrf_guard, auth_guard, then exactly one can:', () => {
        for (const route of adminHttp) {
            expect(route.middlewares, key(route)).toEqual([
                'session_web',
                'csrf_guard',
                'auth_guard',
                `can:${HTTP_ROUTE_PERMISSION[key(route)] ?? 'missing'}`,
            ])
        }
    })

    it('no route anywhere names the removed admin_guard', () => {
        for (const route of [...http, ...ws]) {
            expect(route.middlewares ?? [], key(route)).not.toContain('admin_guard')
            expect(route.middlewares ?? [], key(route)).not.toContain('ws_admin_guard')
        }
    })

    it('an anonymous request gets 401 from auth_guard before can:', async () => {
        for (const route of adminHttp) {
            const context = httpContext(null)
            const passed = await executeMiddlewares(fromAuthGuard(route), context)
            expect(passed, key(route)).toBe(false)
            expect(context.responseData.status, key(route)).toBe(401)
        }
        expect(findRole).not.toHaveBeenCalled()
    })

    it.each(ROLES)('%s passes exactly the routes its permissions allow', async (role) => {
        findRole.mockResolvedValue(role)
        for (const route of adminHttp) {
            const allowed = ROLE_PERMISSIONS[role].includes(HTTP_ROUTE_PERMISSION[key(route)] ?? '')
            const context = httpContext('7')
            const passed = await executeMiddlewares(fromAuthGuard(route), context)
            expect(passed, `${role} ${key(route)}`).toBe(allowed)
            expect(context.responseData.status, `${role} ${key(route)}`).toBe(allowed ? 200 : 403)
        }
    })
})

describe('WS access matrix (feat-240)', () => {
    it('lists exactly the admin WS routes of the table', () => {
        expect(adminWs.map((route) => route.url).sort()).toEqual(
            Object.keys(WS_ROUTE_PERMISSION).sort(),
        )
    })

    it('each needs its ws_can:, except leaving the channel, which needs none', () => {
        for (const route of adminWs) {
            const permission = WS_ROUTE_PERMISSION[route.url]
            expect(route.middlewares ?? [], route.url).toEqual(
                permission === null || permission === undefined ? [] : [`ws_can:${permission}`],
            )
        }
    })

    it.each(ROLES)('%s passes exactly the WS routes its permissions allow', async (role) => {
        for (const route of adminWs) {
            const permission = WS_ROUTE_PERMISSION[route.url]
            const allowed =
                permission === null || permission === undefined
                    ? true
                    : ROLE_PERMISSIONS[role].includes(permission)
            const context = wsContext({ role })
            const passed = await executeWsMiddlewares(route.middlewares, context)
            expect(passed, `${role} ${route.url}`).toBe(allowed)
            expect(context.responseData.status, `${role} ${route.url}`).toBe(
                allowed ? '200' : '403',
            )
        }
    })

    it('a paused admin channel refuses the subscription but still lets the socket leave', async () => {
        for (const route of adminWs) {
            const context = wsContext({ role: 'admin', adminChannelPaused: true })
            const passed = await executeWsMiddlewares(route.middlewares, context)
            expect(passed, route.url).toBe(WS_ROUTE_PERMISSION[route.url] === null)
        }
    })
})
