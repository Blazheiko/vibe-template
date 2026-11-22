import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { enrollTestTotp, type TestTotp } from '../../../test-support/test-totp.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import { isStaffRole, type Role } from 'shared/access'

// feat-235 T6 and T6a: GET /admin/audit-events over HTTP with the real route table, session_web,
// csrf_guard, auth_guard and admin_guard, against a real PostgreSQL and Redis: who may read the
// log, every filter, the cursor over events with one occurred_at, and the history of one object
// in the order its changes were applied (two edits of a prompt and of an article that raced for
// the row lock). Only per-IP limits, the auth throttle, notifications and indexing are replaced.

const getFreePort = () =>
    new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() => {
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
    })

const PORT = await getFreePort()
const ORIGIN = `http://localhost:${String(PORT)}`

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_STRICT_ORIGIN'] = 'true'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})
process.env['CSRF_ALLOWED_ORIGINS'] = ORIGIN

const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            host: '127.0.0.1',
            port: PORT,
            serveStatic: false,
            unixPath: undefined,
            pathPrefix: 'api',
        },
    }
})
vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})
vi.mock('#vendor/utils/rate-limit/http-rate-limit.js', () => ({
    default: () => true,
    checkGlobalRateLimit: () => true,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: {
        indexArticle: () => Promise.resolve(true),
        reindexAll: () => Promise.resolve({ indexed: 0, failed: [] }),
    },
}))

const PASSWORD = 'role-http-secret-123'

describe.skipIf(!hasPg || !hasRedis)('PATCH /admin/users/:id/role (feat-241)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { auditEvents, users } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: sessionConfig } = await import('#config/session.js')

    await import('#app/start/index.js')

    const redisAdmin = createTestRedis(PREFIX)
    const now = Date.now()
    const createdUserIds: bigint[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    let inserted = 0

    const insertUser = async (role: Role, name = 'role-http', verified = true) => {
        inserted += 1
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `role-http-${String(now)}-${String(inserted)}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: verified ? new Date() : null,
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    interface Reply {
        status: number
        body: Record<string, unknown>
    }

    class Browser {
        cookie: string | undefined
        csrf: string | undefined
        /** Other cookies, such as the second-step ticket of a sign-in with MFA (feat-247). */
        others = new Map<string, string>()

        async request(
            method: 'GET' | 'POST' | 'PATCH',
            path: string,
            body?: unknown,
        ): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            const cookies = [...this.others].map(([name, value]) => `${name}=${value}`)
            if (this.cookie !== undefined)
                cookies.push(`${sessionConfig.cookieName}=${this.cookie}`)
            if (cookies.length > 0) headers['cookie'] = cookies.join('; ')
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            for (const line of response.headers.getSetCookie()) {
                const [pair = ''] = line.split(';')
                const name = pair.slice(0, pair.indexOf('='))
                if (name === sessionConfig.cookieName) continue
                const value = pair.slice(pair.indexOf('=') + 1)
                if (value === '') this.others.delete(name)
                else this.others.set(name, value)
            }
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            if (setCookie !== undefined) {
                this.cookie = setCookie.slice(
                    sessionConfig.cookieName.length + 1,
                    setCookie.indexOf(';'),
                )
            }
            if (typeof parsed['csrfToken'] === 'string') this.csrf = parsed['csrfToken']
            return { status: response.status, body: parsed }
        }

        /** Signs in; with `totp`, answers the second step (a staff account has MFA, feat-247). */
        async signIn(email: string, totp?: TestTotp): Promise<void> {
            await this.request('GET', '/main/init')
            const reply = await this.request('POST', '/auth/login', {
                identifier: email,
                password: PASSWORD,
            })
            expect(reply.status).toBe(200)
            if (reply.body['status'] !== 'mfa_required') return
            if (totp === undefined) throw new Error('the account asks for a second factor')
            const verified = await this.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: totp.code(),
            })
            expect(verified.status).toBe(200)
        }

        setRole(id: bigint | string, body: unknown): Promise<Reply> {
            return this.request('PATCH', `/admin/users/${String(id)}/role`, body)
        }

        users(query: string): Promise<Reply> {
            return this.request('GET', `/admin/users?${query}`)
        }
    }

    const signedIn = async (role: Role, name?: string) => {
        const user = await insertUser(role, name)
        // feat-247 (Р10): a staff role uses its permissions with a second factor (on by default).
        const totp = isStaffRole(role) ? await enrollTestTotp(user.id) : undefined
        const browser = new Browser()
        await browser.signIn(user.email ?? '', totp)
        return { user, browser }
    }

    beforeAll(async () => {
        await redisAdmin.connect()
        await redisClient.connect()
        const { routesHandler, createWsRoutesByUrl } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const { default: wsRoutes } = await import('#app/routes/ws-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: createWsRoutesByUrl(routesHandler(wsRoutes)),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: wsRoutes,
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await stopServer?.('test')
        for (const id of createdUserIds) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(auditEvents).where(eq(auditEvents.actorUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        await cleanupTestRedis(redisAdmin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await redisAdmin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    const roleOf = async (id: bigint): Promise<Role | undefined> => {
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id))
        return row?.role
    }

    it('answers 401 without a session and 403 without users.roles.assign', async () => {
        const target = await insertUser('user')
        const anonymous = new Browser()
        await anonymous.request('GET', '/main/init')
        expect((await anonymous.setRole(target.id, { role: 'kb_editor' })).status).toBe(401)

        for (const role of ['user', 'support_operator', 'kb_editor'] as const) {
            const { browser } = await signedIn(role)
            const reply = await browser.setRole(target.id, { role: 'kb_editor' })
            expect(reply.status, role).toBe(403)
            expect(reply.body).toMatchObject({ status: 'error', code: 'forbidden' })
        }
        expect(await roleOf(target.id)).toBe('user')
    })

    it('lets an admin give a role, with an audit event of the request, and lists it', async () => {
        const { user: admin, browser } = await signedIn('admin')
        const target = await insertUser('user', 'future editor')
        await enrollTestTotp(target.id)

        const reply = await browser.setRole(target.id, { role: 'kb_editor' })

        expect(reply.status).toBe(200)
        expect(reply.body).toEqual({
            status: 'success',
            user: { id: String(target.id), role: 'kb_editor' },
            changed: true,
        })
        const [event] = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.targetUserId, target.id))
        expect(event).toMatchObject({
            action: 'user.role.changed',
            actorKind: 'user',
            actorUserId: admin.id,
            actorRole: 'admin',
            changes: { role: { from: 'user', to: 'kb_editor' } },
        })
        expect(event?.requestId).toMatch(/^[0-9a-f-]{36}$/)

        const again = await browser.setRole(target.id, { role: 'kb_editor' })
        expect(again.body).toMatchObject({ status: 'success', changed: false })

        const listed = await browser.users(`userId=${String(target.id)}`)
        expect(listed.body['items']).toEqual([
            expect.objectContaining({
                id: String(target.id),
                role: 'kb_editor',
                emailVerified: true,
            }),
        ])
        const filtered = await browser.users('role=kb_editor&limit=100')
        const roles = (filtered.body['items'] as { role: string }[]).map((item) => item.role)
        expect(roles.length).toBeGreaterThan(0)
        expect(new Set(roles)).toEqual(new Set(['kb_editor']))
    })

    it('holds a user_admin to its delegation policy and refuses its own role', async () => {
        const { user: userAdmin, browser } = await signedIn('user_admin')
        const target = await insertUser('user')
        await enrollTestTotp(target.id)
        const admin = await insertUser('admin')

        expect((await browser.setRole(target.id, { role: 'support_operator' })).status).toBe(200)
        for (const [id, role] of [
            [target.id, 'admin'],
            [target.id, 'user_admin'],
            [admin.id, 'user'],
            [userAdmin.id, 'user'],
        ] as const) {
            const reply = await browser.setRole(id, { role })
            expect(reply.status, `${String(id)} ${role}`).toBe(403)
        }
        expect(await roleOf(admin.id)).toBe('admin')
        expect(await roleOf(userAdmin.id)).toBe('user_admin')
    })

    it('answers 409 identity_unverified, 404, 400 and 422 with the canonical bodies', async () => {
        const { browser } = await signedIn('admin')
        const unverified = await insertUser('user', 'unverified', false)

        const refused = await browser.setRole(unverified.id, { role: 'support_operator' })
        expect(refused.status).toBe(409)
        expect(refused.body).toMatchObject({
            status: 'error',
            code: 'conflict',
            reason: 'identity_unverified',
        })

        expect((await browser.setRole(9_000_000_000_000n, { role: 'user' })).status).toBe(404)
        expect((await browser.setRole('abc', { role: 'user' })).status).toBe(400)
        expect((await browser.setRole(unverified.id, { role: 'root' })).status).toBe(422)
        expect((await browser.setRole(unverified.id, { role: 'user', extra: 1 })).status).toBe(422)
    })

    // feat-247 (Р10): a staff role is given only to an account with a second factor.
    it('answers 409 mfa_not_enrolled for a staff role to an account without MFA', async () => {
        const { browser } = await signedIn('admin')
        const target = await insertUser('user', 'no factor')

        const refused = await browser.setRole(target.id, { role: 'support_operator' })
        expect(refused.status).toBe(409)
        expect(refused.body).toMatchObject({
            status: 'error',
            code: 'conflict',
            reason: 'mfa_not_enrolled',
        })
        expect(await roleOf(target.id)).toBe('user')

        await enrollTestTotp(target.id)
        expect((await browser.setRole(target.id, { role: 'support_operator' })).status).toBe(200)
        expect(await roleOf(target.id)).toBe('support_operator')
    })

    it('refuses an actor lowered since its session began (the guard reads the role per request)', async () => {
        const { user: userAdmin, browser } = await signedIn('user_admin')
        const target = await insertUser('user')
        await db.update(users).set({ role: 'user' }).where(eq(users.id, userAdmin.id))

        const reply = await browser.setRole(target.id, { role: 'kb_editor' })

        expect(reply.status).toBe(403)
        expect(await roleOf(target.id)).toBe('user')
    })
})
