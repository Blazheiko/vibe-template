import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

// The session token handler (loaded with the real route table) refuses to import
// without a key of at least 32 characters; this one signs nothing here.
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
// turns the `x-test-user` header into the request's user (and `x-test-token` into the
// session token it presents, feat-098), so the real route table, body validation,
// `auth_guard`, controller, service and repository run unchanged.
vi.mock('#vendor/utils/middlewares/ws/session-web.js', () => ({
    default: async (
        context: {
            httpData: { headers: Map<string, string> }
            auth: {
                check: () => boolean
                getUserId: () => string | null
                getPresentedUserToken: () => string | undefined
            }
        },
        next: () => Promise<void>,
    ): Promise<void> => {
        const userId = context.httpData.headers.get('x-test-user') ?? null
        const token = context.httpData.headers.get('x-test-token')
        context.auth = {
            ...context.auth,
            check: () => userId !== null,
            getUserId: () => userId,
            getPresentedUserToken: () => token,
        }
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
    const { pushNotificationLogs, pushSubscriptions, users } = await import('#database/schema.js')

    const now = Date.now()
    const ids = { owner: 0n, other: 0n, ownerSub: 0n, otherSub: 0n, missing: 0n }
    let stopServer: ((type?: string) => Promise<void>) | undefined
    const sessionTokens = new Map<string, string>()

    const insertUser = async (name: string): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${String(now)}@example.test` })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (row === undefined) throw new Error('user not inserted')
        sessionTokens.set(String(row.id), row.sessionToken)
        return row.id
    }

    const insertSubscription = async (userId: bigint, tag: string): Promise<bigint> => {
        const [row] = await db
            .insert(pushSubscriptions)
            .values({
                userId,
                endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${String(now)}`,
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
        if (options.user !== undefined) {
            headers['x-test-user'] = String(options.user)
            const token = sessionTokens.get(String(options.user))
            if (token !== undefined) headers['x-test-token'] = token
        }
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
        expect(result.text).not.toContain(`/fcm/send/${tag}-`)
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

    // feat-098: a request whose session was revoked (a claim rotated the token) after it
    // was admitted writes nothing.
    describe('POST /push-subscriptions from a revoked session', () => {
        it('answers 401 session_revoked and inserts nothing', async () => {
            const endpoint = `https://fcm.googleapis.com/fcm/send/revoked-${String(now)}`
            sessionTokens.set(String(ids.other), 'token-before-the-claim')

            try {
                const result = await call('POST', '', {
                    user: ids.other,
                    body: { endpoint, p256dhKey: 'key', authKey: 'auth' },
                })

                expect(result.status).toBe(401)
                expect(result.body).toMatchObject({ reason: 'session_revoked' })
            } finally {
                const [row] = await db
                    .select({ sessionToken: users.sessionToken })
                    .from(users)
                    .where(eq(users.id, ids.other))
                if (row !== undefined) sessionTokens.set(String(ids.other), row.sessionToken)
            }
            const rows = await db
                .select()
                .from(pushSubscriptions)
                .where(eq(pushSubscriptions.endpoint, endpoint))
            expect(rows).toHaveLength(0)
        })
    })

    // feat-104 (R03): the server POSTs to the stored endpoint, so only allowed push services are
    // stored, the number of devices is capped, and the transport error text stays in the database.
    describe('push endpoint SSRF (feat-104)', () => {
        const countFor = async (userId: bigint): Promise<number> =>
            (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)))
                .length

        it.each([
            'https://10.0.0.5/admin',
            'https://169.254.169.254/latest/meta-data',
            'http://fcm.googleapis.com/fcm/send/x',
            'https://evil.example/fcm.googleapis.com',
        ])('POST answers 400 for %s and stores nothing', async (endpoint) => {
            const before = await countFor(ids.owner)

            const result = await call('POST', '', {
                user: ids.owner,
                body: { endpoint, p256dhKey: 'key', authKey: 'auth' },
            })

            expect(result.status).toBe(400)
            expect(result.body).toMatchObject({ reason: 'push_endpoint_not_allowed' })
            expect(await countFor(ids.owner)).toBe(before)
        })

        it('every channel that returns logs hides the transport error text', async () => {
            const subscriptionId = await insertSubscription(ids.owner, 'logs')
            await db.insert(pushNotificationLogs).values([
                {
                    userId: ids.owner,
                    subscriptionId,
                    messageTitle: 'failed',
                    status: 'FAILED',
                    errorMessage: 'connect ECONNREFUSED 10.0.0.5:22',
                    responseData: { statusCode: null },
                },
                {
                    userId: ids.owner,
                    subscriptionId,
                    messageTitle: 'gone',
                    status: 'FAILED',
                    errorMessage: 'Received unexpected response code 410 from 10.0.0.5',
                    responseData: { statusCode: 410 },
                },
            ])

            const channels = [
                await call('GET', '', { user: ids.owner }),
                await call('GET', `/${String(subscriptionId)}`, { user: ids.owner }),
                await call('GET', `/${String(subscriptionId)}/logs`, { user: ids.owner }),
            ]

            for (const result of channels) {
                expect(result.status).toBe(200)
                expect(result.text).not.toContain('ECONNREFUSED')
                expect(result.text).not.toContain('10.0.0.5')
                expect(result.text).not.toContain('errorMessage')
                expect(result.text).not.toContain('responseData')
            }
            const logs = (channels[2]?.body['data'] ?? []) as Record<string, unknown>[]
            expect(logs).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ statusCode: null, reason: 'network_error' }),
                    expect.objectContaining({ statusCode: 410, reason: 'gone' }),
                ]),
            )
        })

        it('two parallel POSTs for the last free slot store one subscription', async () => {
            const capped = await insertUser('push-capped')
            try {
                for (let index = 0; index < 19; index += 1) {
                    await insertSubscription(capped, `cap${String(index)}`)
                }

                const results = await Promise.all(
                    ['a', 'b'].map((tag) =>
                        call('POST', '', {
                            user: capped,
                            body: {
                                endpoint: `https://fcm.googleapis.com/fcm/send/last-${tag}-${String(now)}`,
                                p256dhKey: `key-${tag}`,
                                authKey: `auth-${tag}`,
                            },
                        }),
                    ),
                )

                expect(results.map((result) => result.status).sort()).toEqual([200, 409])
                expect(results.find((result) => result.status === 409)?.body).toMatchObject({
                    reason: 'push_subscription_limit',
                })
                expect(await countFor(capped)).toBe(20)
            } finally {
                await db.delete(users).where(eq(users.id, capped))
            }
        })

        it('POST /test-push is rate limited', async () => {
            const statuses: number[] = []
            for (let index = 0; index < 6; index += 1) {
                statuses.push(
                    (await call('POST', '/test-push', { user: ids.owner, body: {} })).status,
                )
            }

            expect(statuses.slice(0, 5)).not.toContain(429)
            expect(statuses[5]).toBe(429)
        })
    })
})
