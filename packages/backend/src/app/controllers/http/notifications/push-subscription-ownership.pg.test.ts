import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

// session-api (loaded with the real route table) refuses to import without a key of
// at least 32 characters; this one signs nothing here.
vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

// `child` is needed: every request builds its context logger with it.
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

// The session and CSRF layers have their own tests (Redis). Here `session_web` only
// turns the `x-test-user` header into the request's user, so the real route table,
// body validation, `auth_guard`, controller, service and repository run unchanged.
vi.mock('#vendor/utils/middlewares/ws/session-web.js', () => ({
    default: async (
        context: {
            httpData: { headers: Map<string, string> }
            auth: { check: () => boolean; getUserId: () => string | null }
        },
        next: () => Promise<void>,
    ): Promise<void> => {
        const userId = context.httpData.headers.get('x-test-user') ?? null
        context.auth = { ...context.auth, check: () => userId !== null, getUserId: () => userId }
        await next()
    },
}))
vi.mock('#app/middlewares/csrf-guard.js', () => ({
    default: async (_context: unknown, next: () => Promise<void>): Promise<void> => {
        await next()
    },
}))

// feat-058: PUT /push-subscriptions/:id and PUT /:id/deactivate used to re-read the
// row by id alone after a user-scoped UPDATE, so a foreign id answered 200 with
// another user's subscription (endpoint, push keys, IP, user agent). Requests go
// through a real uWebSockets.js server with the real route table and PostgreSQL.
describe.skipIf(!hasPg)('push subscription ownership over HTTP on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { pushSubscriptions, users } = await import('#database/schema.js')

    const now = Date.now()
    const ids = { owner: 0n, other: 0n, ownerSub: 0n, otherSub: 0n, missing: 0n }
    let stopServer: ((type?: string) => Promise<void>) | undefined

    const insertUser = async (name: string): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${String(now)}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        return row.id
    }

    const insertSubscription = async (userId: bigint, tag: string): Promise<bigint> => {
        const [row] = await db
            .insert(pushSubscriptions)
            .values({
                userId,
                endpoint: `https://push.example.test/${tag}-${String(now)}`,
                p256dhKey: `p256dh-${tag}`,
                authKey: `auth-${tag}`,
                ipAddress: '203.0.113.7',
                userAgent: `agent-${tag}`,
                isActive: true,
            })
            .returning({ id: pushSubscriptions.id })
        if (row === undefined) throw new Error('subscription not inserted')
        return row.id
    }

    const rowOf = async (id: bigint) => {
        const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id))
        return row
    }

    interface HttpResult {
        status: number
        text: string
        body: Record<string, unknown>
    }

    const call = async (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        options: { user?: bigint; body?: unknown } = {},
    ): Promise<HttpResult> => {
        const headers: Record<string, string> = {}
        if (options.user !== undefined) headers['x-test-user'] = String(options.user)
        const hasBody = options.body !== undefined
        if (hasBody) headers['content-type'] = 'application/json'
        const response = await fetch(
            `http://127.0.0.1:${String(PORT)}/api/push-subscriptions${path}`,
            {
                method,
                headers,
                ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
            },
        )
        const text = await response.text()
        const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
        return { status: response.status, text, body }
    }

    const expectNoLeak = (result: HttpResult, tag: string): void => {
        expect(result.text).not.toContain('push.example.test')
        expect(result.text).not.toContain(`p256dh-${tag}`)
        expect(result.text).not.toContain(`auth-${tag}`)
        expect(result.text).not.toContain('203.0.113.7')
        expect(result.text).not.toContain(`agent-${tag}`)
    }

    beforeAll(async () => {
        ids.owner = await insertUser('push-owner')
        ids.other = await insertUser('push-other')
        ids.ownerSub = await insertSubscription(ids.owner, 'owner')
        ids.otherSub = await insertSubscription(ids.other, 'other')
        ids.missing = ids.otherSub + 1_000_000n

        const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
        wsHandlers.registerWsAppHooks({
            onUpgrade: () => Promise.resolve({ kind: 'missing' as const }),
            onConnected: () => Promise.resolve(),
            onDisconnected: () => Promise.resolve(),
            onRefreshToken: () => Promise.resolve(),
            onRevokeToken: () => Promise.resolve(),
        })
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
        await db.delete(users).where(eq(users.id, ids.owner))
        await db.delete(users).where(eq(users.id, ids.other))
        await pool.end()
    })

    describe('PUT /push-subscriptions/:subscriptionId', () => {
        it('answers 401 from auth_guard without a user and changes nothing', async () => {
            const before = await rowOf(ids.ownerSub)

            const result = await call('PUT', `/${String(ids.ownerSub)}`, {
                body: { isActive: false },
            })

            expect(result.status).toBe(401)
            expectNoLeak(result, 'owner')
            expect(await rowOf(ids.ownerSub)).toEqual(before)
        })

        it('rejects an invalid body with 422 before the controller', async () => {
            const before = await rowOf(ids.ownerSub)

            const result = await call('PUT', `/${String(ids.ownerSub)}`, {
                user: ids.owner,
                body: { isActive: false, userId: '1' },
            })

            expect(result.status).toBe(422)
            expect(await rowOf(ids.ownerSub)).toEqual(before)
        })

        it('answers a foreign id like a missing one and leaks nothing', async () => {
            const before = await rowOf(ids.ownerSub)

            const foreign = await call('PUT', `/${String(ids.ownerSub)}`, {
                user: ids.other,
                body: { isActive: false },
            })
            const missing = await call('PUT', `/${String(ids.missing)}`, {
                user: ids.other,
                body: { isActive: false },
            })

            expect(foreign.status).toBe(404)
            expect(missing.status).toBe(404)
            expect(foreign.body).toEqual(missing.body)
            expectNoLeak(foreign, 'owner')
            expect(await rowOf(ids.ownerSub)).toEqual(before)
        })

        it('leaks nothing for an empty body either', async () => {
            const foreign = await call('PUT', `/${String(ids.ownerSub)}`, {
                user: ids.other,
                body: {},
            })

            expect(foreign.status).toBe(404)
            expectNoLeak(foreign, 'owner')
        })

        it('updates the caller own subscription', async () => {
            const result = await call('PUT', `/${String(ids.ownerSub)}`, {
                user: ids.owner,
                body: { isActive: false, timezone: 'UTC' },
            })

            expect(result.status).toBe(200)
            expect(result.body).toMatchObject({ status: 'success' })
            const row = await rowOf(ids.ownerSub)
            expect(row?.isActive).toBe(false)
            expect(row?.timezone).toBe('UTC')
        })
    })

    describe('PUT /push-subscriptions/:subscriptionId/deactivate', () => {
        it('answers 401 without a user and keeps the row active', async () => {
            const result = await call('PUT', `/${String(ids.otherSub)}/deactivate`, { body: {} })

            expect(result.status).toBe(401)
            expect((await rowOf(ids.otherSub))?.isActive).toBe(true)
        })

        it('answers a foreign id like a missing one, leaks nothing and keeps the row active', async () => {
            const before = await rowOf(ids.otherSub)

            const foreign = await call('PUT', `/${String(ids.otherSub)}/deactivate`, {
                user: ids.owner,
                body: {},
            })
            const missing = await call('PUT', `/${String(ids.missing)}/deactivate`, {
                user: ids.owner,
                body: {},
            })

            expect(foreign.status).toBe(404)
            expect(missing.status).toBe(404)
            expect(foreign.body).toEqual(missing.body)
            expectNoLeak(foreign, 'other')
            const after = await rowOf(ids.otherSub)
            expect(after).toEqual(before)
            expect(after?.isActive).toBe(true)
        })

        it('deactivates the caller own subscription', async () => {
            const result = await call('PUT', `/${String(ids.otherSub)}/deactivate`, {
                user: ids.other,
                body: {},
            })

            expect(result.status).toBe(200)
            expect(result.body).toMatchObject({ status: 'success' })
            expect((await rowOf(ids.otherSub))?.isActive).toBe(false)
        })
    })

    // The other routes with :subscriptionId were already owner-scoped; their
    // contract is pinned here because the docs state it.
    describe('the other routes with :subscriptionId', () => {
        it('GET /:id answers 404 for a foreign id and leaks nothing', async () => {
            const result = await call('GET', `/${String(ids.ownerSub)}`, { user: ids.other })

            expect(result.status).toBe(404)
            expectNoLeak(result, 'owner')
        })

        it('GET /:id/statistics answers 404 for a foreign id', async () => {
            const result = await call('GET', `/${String(ids.ownerSub)}/statistics`, {
                user: ids.other,
            })

            expect(result.status).toBe(404)
            expectNoLeak(result, 'owner')
        })

        // Unlike the routes above, this one does not look the subscription up: the
        // logs are filtered by owner, so a foreign or missing id is an empty list.
        it('GET /:id/logs answers 200 with an empty list for a foreign id', async () => {
            const result = await call('GET', `/${String(ids.ownerSub)}/logs`, { user: ids.other })

            expect(result.status).toBe(200)
            expect(result.body).toMatchObject({ data: [] })
            expectNoLeak(result, 'owner')
        })

        it('DELETE /:id answers 404 for a foreign id and keeps the row', async () => {
            const result = await call('DELETE', `/${String(ids.ownerSub)}`, { user: ids.other })

            expect(result.status).toBe(404)
            expect(await rowOf(ids.ownerSub)).toBeDefined()
        })
    })

    // The endpoint is unique across users. Moving it to another account is allowed
    // only with the browser's keys (same device, account switch) — the repository
    // method has no userId in its WHERE on purpose.
    describe('POST /push-subscriptions for an endpoint owned by another user', () => {
        it('moves the subscription to the caller when the browser keys match', async () => {
            const id = await insertSubscription(ids.owner, 'move')
            const row = await rowOf(id)
            if (row === undefined) throw new Error('subscription missing')

            const result = await call('POST', '', {
                user: ids.other,
                body: { endpoint: row.endpoint, p256dhKey: row.p256dhKey, authKey: row.authKey },
            })

            expect(result.status).toBe(200)
            expect((await rowOf(id))?.userId).toBe(ids.other)
        })

        it('answers 409 and keeps the owner when the keys differ', async () => {
            const id = await insertSubscription(ids.owner, 'conflict')
            const row = await rowOf(id)
            if (row === undefined) throw new Error('subscription missing')

            const result = await call('POST', '', {
                user: ids.other,
                body: { endpoint: row.endpoint, p256dhKey: 'wrong', authKey: 'wrong' },
            })

            expect(result.status).toBe(409)
            expect((await rowOf(id))?.userId).toBe(ids.owner)
        })
    })
})
