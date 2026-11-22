import { describe, expect, it, vi } from 'vitest'

import type { HttpContext } from '#vendor/types/types.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р8, tasks M9): every route of the registry, for a
// recovery session. A route behind `session_web` answers 403 `recovery_session` before its
// handler unless it allows recovery; a route without `session_web` never restores a session, so
// the rule does not reach it. The list of the routes that allow recovery is written out.

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
vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { default: httpRoutes } = await import('./http-routes.js')
const { routesHandler } = await import('#vendor/start/router.js')
const { recoveryGate } = await import('#vendor/utils/middlewares/ws/session-web.js')

const http = routesHandler(httpRoutes)
const now = Date.now()
const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString()

const contextOf = (
    allowInRecovery: boolean,
    recovery: { startedAt: string; expiresAt: string } | undefined,
): HttpContext =>
    ({
        httpData: { allowInRecovery },
        responseData: { status: 200, payload: null },
        session: {
            sessionInfo: {
                id: 's',
                createdAt: iso(-1000),
                data: {
                    auth: {
                        v: 1,
                        amr: ['pwd', 'recovery'],
                        aal: 1,
                        authenticatedAt: iso(-1000),
                        verified: {},
                        ...(recovery !== undefined ? { recovery } : {}),
                    },
                },
            },
        },
    }) as unknown as HttpContext

const ACTIVE = { startedAt: iso(-1000), expiresAt: iso(600_000) }

describe('recovery session over the route registry (feat-245 Р8)', () => {
    it('exactly these routes let a recovery session in, and each one restores the session', () => {
        const allowed = http
            .filter((route) => route.allowInRecovery === true)
            .map((route) => `${route.method} ${route.url}`)
            .sort()
        expect(allowed).toEqual([
            'del api/account/mfa/totp',
            'get api/account/mfa',
            'get api/main/init',
            'post api/account/mfa/recovery-codes',
            'post api/account/mfa/totp/confirm',
            'post api/account/mfa/totp/setup',
            'post api/auth/logout',
            'post api/auth/recovery/finish',
        ])
        for (const route of http.filter((r) => r.allowInRecovery === true)) {
            expect(route.middlewares ?? [], route.url).toContain('session_web')
        }
    })

    it('every route behind session_web: 403 recovery_session unless it allows recovery', () => {
        const withSession = http.filter((route) =>
            (route.middlewares ?? []).includes('session_web'),
        )
        // The sign-in, reset and OAuth routes are among them (no auth_guard, but a session).
        const urls = withSession.map((route) => route.url)
        for (const url of [
            'api/auth/login',
            'api/auth/forgot-password',
            'api/auth/reset-password',
            'api/auth/oauth/:provider/callback',
            'api/auth/oauth/link/confirm',
        ]) {
            expect(urls).toContain(url)
        }
        for (const route of withSession) {
            const context = contextOf(route.allowInRecovery === true, ACTIVE)
            const passed = recoveryGate(context)
            if (route.allowInRecovery === true) {
                expect(passed, route.url).toBe(true)
            } else {
                expect(passed, route.url).toBe(false)
                expect(context.responseData.status, route.url).toBe(403)
                expect(context.responseData.payload, route.url).toMatchObject({
                    reason: 'recovery_session',
                })
            }
        }
    })

    it('a session that is not (or no longer) a recovery session passes everywhere', () => {
        for (const route of http) {
            expect(recoveryGate(contextOf(false, undefined)), route.url).toBe(true)
            const expired = { startedAt: iso(-2_000_000), expiresAt: iso(-1) }
            expect(recoveryGate(contextOf(false, expired)), route.url).toBe(true)
        }
    })

    it('a route without session_web restores no session: the gate never runs there', () => {
        const without = http.filter((route) => !(route.middlewares ?? []).includes('session_web'))
        expect(without.map((route) => route.url)).toEqual(
            expect.arrayContaining(['api/ping', 'api/ready']),
        )
        for (const route of without) expect(route.allowInRecovery, route.url).not.toBe(true)
    })
})
