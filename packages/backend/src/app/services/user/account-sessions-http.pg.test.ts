import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'
import { WsTestClient } from '../../../test-support/ws-test-client.js'
import type { OneTimeTokenRowId, UserId } from '#app/domain/ids.js'

// feat-233 T4: GET /account/sessions, DELETE /account/sessions/:id and POST
// /account/sessions/revoke-others over HTTP and WebSocket: a real uWebSockets.js server with the
// real route table, session_web, csrf_guard and auth_guard, against a real PostgreSQL and Redis.
// Only per-IP limits, the auth throttle and notifications are replaced.

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
    process.env['SESSION_TOKEN_CHECK_TIMEOUT_MS'] = '400'
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
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: { send: vi.fn(() => Promise.resolve({ status: 'ok', value: undefined })) },
}))

const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'

describe.skipIf(!hasPg || !hasRedis)('account sessions over HTTP (feat-233)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, passwordResetTokens } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: sessionConfig } = await import('#config/session.js')

    // Registers the WebSocket hooks, the message validator and the sessionToken check.
    await import('#app/start/index.js')
    // What index.ts wires at startup: a sign-in or a logout announces the list change.
    const { onSessionListChanged } = await import('#vendor/utils/session/session-list-events.js')
    const { announceSessionListChanged } =
        await import('#app/services/communication/session-list-announcer.js')
    onSessionListChanged(announceSessionListChanged)

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const PASSWORD = 'sessions-secret-123'
    const createdUserIds: UserId[] = []
    const sockets: WebSocket[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    let inserted = 0
    const insertUser = async () => {
        inserted += 1
        const [row] = await db
            .insert(users)
            .values({
                name: 'sessions',
                email: `sessions-${String(now)}-${String(inserted)}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    class Socket extends WsTestClient {
        static connect(token: string): Promise<Socket> {
            return WsTestClient.open((ws) => new Socket(ws), PORT, token, sockets)
        }
    }

    interface Reply {
        status: number
        body: Record<string, unknown>
        setCookie: string | undefined
    }

    class Browser {
        cookie: string | undefined
        csrf: string | undefined
        wsToken: string | undefined

        constructor(readonly userAgent = CHROME_MAC) {}

        async request(
            method: 'GET' | 'POST' | 'DELETE',
            path: string,
            body?: unknown,
        ): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN, 'user-agent': this.userAgent }
            if (this.cookie !== undefined)
                headers['cookie'] = `${sessionConfig.cookieName}=${this.cookie}`
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            return { status: response.status, body: parsed, setCookie }
        }

        keep(reply: Reply): Reply {
            if (reply.setCookie !== undefined) {
                this.cookie = reply.setCookie.slice(
                    sessionConfig.cookieName.length + 1,
                    reply.setCookie.indexOf(';'),
                )
            }
            if (typeof reply.body['csrfToken'] === 'string') this.csrf = reply.body['csrfToken']
            if (typeof reply.body['wsToken'] === 'string') this.wsToken = reply.body['wsToken']
            return reply
        }

        async signIn(email: string): Promise<void> {
            this.keep(await this.request('GET', '/main/init'))
            const reply = this.keep(
                await this.request('POST', '/auth/login', {
                    identifier: email,
                    password: PASSWORD,
                }),
            )
            expect(reply.status).toBe(200)
        }

        async list(cursor?: string): Promise<Reply> {
            const query = cursor === undefined ? '' : `?cursor=${cursor}`
            return this.keep(await this.request('GET', `/account/sessions${query}`))
        }

        async revoke(id: string): Promise<Reply> {
            return this.keep(await this.request('DELETE', `/account/sessions/${id}`))
        }

        async revokeOthers(): Promise<Reply> {
            return this.keep(await this.request('POST', '/account/sessions/revoke-others', {}))
        }

        async logoutAll(): Promise<Reply> {
            return this.keep(await this.request('POST', '/auth/logout-all', {}))
        }

        /** feat-245 (Р3): the step-up change-password asks for. */
        async reauth(): Promise<void> {
            const reply = await this.request('POST', '/auth/reauth', {
                proof: 'password',
                password: PASSWORD,
            })
            expect(reply.status).toBe(200)
        }

        async changePassword(): Promise<Reply> {
            return this.keep(
                await this.request('POST', '/auth/change-password', {
                    newPassword: `${PASSWORD}-new`,
                }),
            )
        }

        async socket(): Promise<Socket> {
            if (this.wsToken === undefined) throw new Error('no ws token')
            const socket = await Socket.connect(this.wsToken)
            await socket.waitFor((frame) => frame.event === 'service:connection_ready')
            return socket
        }
    }

    const signedIn = async (email: string, userAgent = CHROME_MAC): Promise<Browser> => {
        const browser = new Browser(userAgent)
        await browser.signIn(email)
        return browser
    }

    type View = Record<string, unknown> & { id: string; online: boolean }
    const viewsOf = (reply: Reply) => ({
        current: reply.body['current'] as View | null,
        others: reply.body['others'] as View[],
    })
    const tokenOf = async (id: UserId) =>
        (await db.select({ t: users.sessionToken }).from(users).where(eq(users.id, id))).at(0)?.t

    // The server says the session is gone and closes with 4001 (endSessionExpired). The Node
    // client stays CLOSING after the close frame (it waits for the TCP end), so the test reads
    // the frame and the state, not the close event.
    const sessionEnded = async (socket: Socket): Promise<void> => {
        await socket.waitFor(
            (frame) =>
                frame.event === 'service:error' &&
                JSON.stringify(frame.error).includes('session_expired'),
        )
        await waitUntil(
            () => Promise.resolve(socket.ws.readyState >= WebSocket.CLOSING),
            'the close frame',
        )
    }

    const waitUntil = async (check: () => Promise<boolean>, what: string): Promise<void> => {
        const started = Date.now()
        while (!(await check())) {
            if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${what}`)
            await sleep(30)
        }
    }

    beforeAll(async () => {
        await admin.connect()
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

    afterAll(async () => {
        onSessionListChanged(null)
        for (const ws of sockets) ws.close()
        await sleep(100)
        await stopServer?.('test')
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    it('lists the current session apart and the others with their devices', async () => {
        const user = await insertUser()
        const laptop = await signedIn(user.email ?? '')
        const phone = await signedIn(user.email ?? '', FIREFOX_LINUX)

        const reply = await laptop.list()
        expect(reply.status).toBe(200)
        const { current, others } = viewsOf(reply)
        expect(current).toMatchObject({
            current: true,
            browser: 'Chrome',
            os: 'macOS',
            deviceType: 'desktop',
            userAgent: CHROME_MAC,
            ip: '127.0.0.1',
            method: 'password',
            provider: null,
            online: false,
        })
        expect(current?.['lastSeenAt']).toEqual(expect.any(String))
        expect(others).toHaveLength(1)
        expect(others[0]).toMatchObject({ current: false, browser: 'Firefox', os: 'Linux' })
        expect(others[0]?.id).not.toBe(current?.id)
        expect(reply.body['nextCursor']).toBeNull()
        // The session id itself is never sent.
        expect(JSON.stringify(reply.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)

        expect((await phone.list('x'.repeat(10))).status).toBe(400)
    })

    it('an anonymous visitor gets 401 on every route', async () => {
        const visitor = new Browser()
        visitor.keep(await visitor.request('GET', '/main/init'))
        expect((await visitor.list()).status).toBe(401)
        expect((await visitor.revoke('a'.repeat(22))).status).toBe(401)
        expect((await visitor.revokeOthers()).status).toBe(401)
    })

    it('ends another session: its next request is 401, its socket closes with 4001', async () => {
        const user = await insertUser()
        const laptop = await signedIn(user.email ?? '')
        const phone = await signedIn(user.email ?? '', FIREFOX_LINUX)
        const phoneSocket = await phone.socket()
        const target = viewsOf(await laptop.list()).others[0]
        if (target === undefined) throw new Error('no other session')

        const reply = await laptop.revoke(target.id)
        expect(reply.status).toBe(200)
        expect(reply.body['status']).toBe('success')
        await sessionEnded(phoneSocket)
        expect((await phone.list()).status).toBe(401)
        expect(security).toHaveBeenCalledWith(user.id, 'session_revoked')
        // The token is not rotated: the laptop goes on, and the phone's session is simply gone.
        expect(await tokenOf(user.id)).toBe(user.sessionToken)
        expect(viewsOf(await laptop.list()).others).toEqual([])

        // Again: 404, which the client takes as done.
        expect((await laptop.revoke(target.id)).status).toBe(404)
    })

    it('the current session is 409 current_session; an unknown or foreign id is 404', async () => {
        const user = await insertUser()
        const other = await insertUser()
        const laptop = await signedIn(user.email ?? '')
        const stranger = await signedIn(other.email ?? '')
        const own = viewsOf(await laptop.list()).current
        const foreign = viewsOf(await stranger.list()).current
        if (own === null || foreign === null) throw new Error('no current session')

        const current = await laptop.revoke(own.id)
        expect(current.status).toBe(409)
        expect(current.body['reason']).toBe('current_session')
        expect((await laptop.revoke(foreign.id)).status).toBe(404)
        expect((await laptop.revoke('Z'.repeat(22))).status).toBe(404)
        expect((await laptop.revoke('not-a-public-id')).status).toBe(404)
        // The stranger's session is untouched.
        expect((await stranger.list()).status).toBe(200)
    })

    it('ends all others: this session goes on with a new CSRF token, the others are 401, resets retired', async () => {
        const user = await insertUser()
        const laptop = await signedIn(user.email ?? '')
        const phone = await signedIn(user.email ?? '', FIREFOX_LINUX)
        const tablet = await signedIn(user.email ?? '')
        const phoneSocket = await phone.socket()
        const laptopSocket = await laptop.socket()
        const [reset] = await db
            .insert(passwordResetTokens)
            .values({
                userId: user.id,
                tokenHash: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
                expiresAt: new Date(Date.now() + 3_600_000),
            })
            .returning()
        const before = viewsOf(await laptop.list()).current
        const oldCsrf = laptop.csrf

        const reply = await laptop.revokeOthers()
        expect(reply.status).toBe(200)
        expect(reply.body).toMatchObject({
            status: 'success',
            sessionRenewed: true,
            csrfToken: expect.any(String),
            wsUrl: expect.any(String),
            wsToken: expect.any(String),
        })
        expect(laptop.csrf).not.toBe(oldCsrf)

        const after = await laptop.list()
        expect(after.status).toBe(200)
        expect(viewsOf(after).others).toEqual([])
        // Renewed, with how and where it signed in kept.
        expect(viewsOf(after).current).toMatchObject({
            method: 'password',
            signedInAt: before?.['signedInAt'],
            userAgent: CHROME_MAC,
        })
        expect(viewsOf(after).current?.id).not.toBe(before?.id)
        expect((await phone.list()).status).toBe(401)
        expect((await tablet.list()).status).toBe(401)
        await sessionEnded(phoneSocket)
        // feat-221: the socket of the session that asked is left for the client to replace.
        expect(laptopSocket.ws.readyState).toBe(WebSocket.OPEN)
        const retired = await db
            .select({ usedAt: passwordResetTokens.usedAt })
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.id, reset?.id ?? (0n as OneTimeTokenRowId)))
        expect(retired[0]?.usedAt).not.toBeNull()
        expect(await tokenOf(user.id)).not.toBe(user.sessionToken)
        expect(security).toHaveBeenCalledWith(user.id, 'logout_all')
    })

    it.each([
        ['revoke-others', 'revoke-others'],
        ['revoke-others', 'logout-all'],
        ['logout-all', 'revoke-others'],
        ['revoke-others', 'change-password'],
        ['change-password', 'revoke-others'],
    ] as const)(
        '%s against %s from two sessions: one rotation, the other refused',
        async (a, b) => {
            const user = await insertUser()
            const first = await signedIn(user.email ?? '')
            const second = await signedIn(user.email ?? '')
            const run = (browser: Browser, what: typeof a) =>
                what === 'revoke-others'
                    ? browser.revokeOthers()
                    : what === 'logout-all'
                      ? browser.logoutAll()
                      : browser.changePassword()
            // The step-up comes before the race; only the actions themselves run in parallel.
            if (a === 'change-password') await first.reauth()
            if (b === 'change-password') await second.reauth()

            const [one, two] = await Promise.all([run(first, a), run(second, b)])
            const [winner, loser] = one.status === 200 ? [one, two] : [two, one]
            expect(winner.status).toBe(200)
            // The loser's session is revoked: 401 session_revoked when it got past the session check
            // before the rotation, or, once the winner deleted its record, an anonymous session whose
            // CSRF token does not match (403 token_mismatch; the client then finds itself signed out).
            expect([401, 403]).toContain(loser.status)
            if (loser.status === 403) expect(loser.body['reason']).toBe('token_mismatch')
            expect(await tokenOf(user.id)).not.toBe(user.sessionToken)
        },
    )

    it('online follows the socket of the session, and the list change reaches the other devices', async () => {
        const user = await insertUser()
        const laptop = await signedIn(user.email ?? '')
        const laptopSocket = await laptop.socket()
        const phone = await signedIn(user.email ?? '', FIREFOX_LINUX)
        // The sign-in of the phone is announced to the laptop.
        await laptopSocket.waitFor((frame) => frame.event === 'broadcast:user_sessions_changed')

        expect(viewsOf(await laptop.list()).current?.online).toBe(true)
        expect(viewsOf(await laptop.list()).others[0]?.online).toBe(false)

        const seenBefore = laptopSocket.received('broadcast:user_sessions_changed')
        const phoneSocket = await phone.socket()
        await waitUntil(
            () =>
                Promise.resolve(
                    laptopSocket.received('broadcast:user_sessions_changed') > seenBefore,
                ),
            'the online event',
        )
        expect(viewsOf(await laptop.list()).others[0]?.online).toBe(true)

        const seenOnline = laptopSocket.received('broadcast:user_sessions_changed')
        phoneSocket.ws.close()
        await waitUntil(
            () =>
                Promise.resolve(
                    laptopSocket.received('broadcast:user_sessions_changed') > seenOnline,
                ),
            'the offline event',
        )
        expect(viewsOf(await laptop.list()).others[0]?.online).toBe(false)
    })
})
