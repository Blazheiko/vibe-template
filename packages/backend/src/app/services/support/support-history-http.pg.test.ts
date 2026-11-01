import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { getFreePort } from '../../../test-support/raw-http.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// feat-063, D3 over HTTP: GET /support/chat/history is read a page at a time. A real server
// with the real route table, session_web, csrf_guard, auth_guard and the query validator,
// against real PostgreSQL and Redis.

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

describe.skipIf(!hasPg || !hasRedis)('support chat history over HTTP', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { supportRepository } = await import('#app/repositories/index.js')
    const { default: sessionConfig } = await import('#config/session.js')

    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const PASSWORD = 'secret-123'
    const createdUserIds: bigint[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    interface Page {
        id: string
        role: string
        content: string
    }
    interface Reply {
        status: number
        body: { status?: string; data?: Page[]; hasMore?: boolean }
        setCookie: string | undefined
    }

    class Browser {
        cookie: string | undefined
        csrf: string | undefined

        async request(
            method: 'GET' | 'POST',
            path: string,
            body?: unknown,
        ): Promise<Reply & { raw: Record<string, unknown> }> {
            const headers: Record<string, string> = { origin: ORIGIN }
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
            const raw = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            return { status: response.status, body: raw, raw, setCookie }
        }

        keep(reply: { setCookie: string | undefined; raw: Record<string, unknown> }): void {
            if (reply.setCookie !== undefined) {
                this.cookie = reply.setCookie.slice(
                    sessionConfig.cookieName.length + 1,
                    reply.setCookie.indexOf(';'),
                )
            }
            if (typeof reply.raw['csrfToken'] === 'string') this.csrf = reply.raw['csrfToken']
        }

        async signIn(email: string): Promise<void> {
            this.keep(await this.request('GET', '/main/init'))
            const reply = await this.request('POST', '/auth/login', {
                identifier: email,
                password: PASSWORD,
                token: '',
            })
            this.keep(reply)
            expect(reply.status).toBe(200)
        }

        history(query = ''): Promise<Reply> {
            return this.request('GET', `/support/chat/history${query}`)
        }
    }

    // A user with `count` messages m1 … mN, signed in.
    const userWith = async (count: number) => {
        const [row] = await db
            .insert(users)
            .values({
                name: 'history-http',
                email: `history-http-${String(createdUserIds.length)}-${String(now)}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        for (let i = 1; i <= count; i++) {
            await supportRepository.addChatMessage(
                row.id,
                i % 2 === 1 ? 'user' : 'assistant',
                `m${String(i)}`,
            )
        }
        const browser = new Browser()
        await browser.signIn(row.email ?? '')
        return { user: row, browser }
    }
    const contents = (reply: Reply): string[] => (reply.body.data ?? []).map((m) => m.content)

    beforeAll(async () => {
        await admin.connect()
        await redisClient.connect()
        const { routesHandler } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: [],
        } as never)
    })

    afterAll(async () => {
        await stopServer?.('test')
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    it('answers the latest 50 messages of a long conversation, not all of it', async () => {
        const { browser } = await userWith(120)

        const reply = await browser.history()

        expect(reply.status).toBe(200)
        expect(reply.body.data).toHaveLength(50)
        expect(contents(reply)[0]).toBe('m71')
        expect(contents(reply).at(-1)).toBe('m120')
        expect(reply.body.hasMore).toBe(true)
    })

    it('walks the whole conversation back with the id of the oldest message it has', async () => {
        const { browser } = await userWith(120)

        const collected: string[] = []
        let query = '?limit=40'
        let pages = 0
        for (;;) {
            const reply = await browser.history(query)
            expect(reply.status).toBe(200)
            collected.unshift(...contents(reply))
            pages += 1
            if (reply.body.hasMore !== true) break
            query = `?limit=40&before=${reply.body.data?.[0]?.id ?? ''}`
        }

        expect(pages).toBe(3)
        expect(collected).toEqual(Array.from({ length: 120 }, (_, i) => `m${String(i + 1)}`))
    })

    it('says there is nothing more for a short conversation', async () => {
        const { browser } = await userWith(3)

        const reply = await browser.history()

        expect(contents(reply)).toEqual(['m1', 'm2', 'm3'])
        expect(reply.body.hasMore).toBe(false)
    })

    it('is empty for a user without messages', async () => {
        const { browser } = await userWith(0)

        const reply = await browser.history()

        expect(reply.status).toBe(200)
        expect(reply.body.data).toEqual([])
        expect(reply.body.hasMore).toBe(false)
    })

    it.each([['?limit=0'], ['?limit=101'], ['?limit=-3'], ['?limit=abc'], ['?limit=1.5']])(
        'refuses the page size %s with 422, reading nothing',
        async (query) => {
            const { browser } = await userWith(2)

            expect((await browser.history(query)).status).toBe(422)
        },
    )

    it.each([
        ['?before=abc'],
        ['?before=0'],
        ['?before=007'],
        ['?before=1e3'],
        [`?before=${'9'.repeat(19)}`],
    ])('refuses the cursor %s with 422', async (query) => {
        const { browser } = await userWith(2)

        expect((await browser.history(query)).status).toBe(422)
    })

    it('accepts the largest page size', async () => {
        const { browser } = await userWith(105)

        const reply = await browser.history('?limit=100')

        expect(reply.status).toBe(200)
        expect(reply.body.data).toHaveLength(100)
        expect(reply.body.hasMore).toBe(true)
    })

    it('does not show another user’s messages, even with their cursor', async () => {
        const mine = await userWith(2)
        const theirs = await userWith(2)
        const theirLast = (await theirs.browser.history()).body.data?.at(-1)?.id ?? ''

        const reply = await mine.browser.history(`?before=${theirLast}`)

        expect(reply.status).toBe(200)
        expect(contents(reply)).toEqual(['m1', 'm2'])
    })

    it('needs a session', async () => {
        const stranger = new Browser()

        expect((await stranger.history()).status).toBe(401)
    })
})
