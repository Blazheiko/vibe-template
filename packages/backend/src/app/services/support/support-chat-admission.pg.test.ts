import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { getFreePort } from '../../../test-support/raw-http.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'
import { WsTestClient, type Frame } from '../../../test-support/ws-test-client.js'

// feat-063 (D0, D1) over real WebSocket connections: the support chat refuses a message
// BEFORE it answers `ok` (a too long one, one that is too frequent, one sent while the
// previous is still being answered), and a failure after admission reaches the client as
// `support_chat_error` with a code. Real server, route tables, sessions, Redis lock and
// PostgreSQL; the three LLM calls are replaced.

const PORT = await getFreePort()

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['SUPPORT_CHAT_USER_RATE_LIMIT_MAX'] = '3'
    process.env['SUPPORT_CHAT_USER_RATE_LIMIT_WINDOW_MS'] = '60000'
    process.env['SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_MAX'] = '2'
    process.env['SUPPORT_OPEN_CHAT_USER_RATE_LIMIT_WINDOW_MS'] = '60000'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})

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
// Per-user counters in memory with the policy's own limit: the plumbing from the policy to
// the 429 is what is under test here (the Redis counter has its own tests).
vi.mock('#app/services/auth/auth-throttle-service.js', () => {
    const counts = new Map<string, number>()
    return {
        consumeAuthThrottle: (policy: { scope: string; limit: number }, key: string) => {
            const id = `${policy.scope}:${key}`
            const count = (counts.get(id) ?? 0) + 1
            counts.set(id, count)
            return Promise.resolve({ allowed: count <= policy.limit, count })
        },
        resetAuthThrottle: () => Promise.resolve(undefined),
    }
})
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))

describe.skipIf(!hasPg || !hasRedis)('support chat admission over WebSocket', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, supportChatHistory } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { supportLlmService } = await import('#app/services/support/support-llm-service.js')
    const { supportEmbeddingService } =
        await import('#app/services/support/support-embedding-service.js')
    const { supportQueryTranslationService } =
        await import('#app/services/support/support-query-translation-service.js')
    const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')
    const { SUPPORT_MESSAGE_MAX_LENGTH } = await import('shared/limits')

    // Registers the WebSocket hooks, the message validator and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const createdUserIds: bigint[] = []
    const clients: WebSocket[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    let counter = 0

    // What the replaced LLM calls do: finish at once, wait for the test, or fail.
    const llm = {
        mode: 'finish' as 'finish' | 'hold' | 'fail',
        release: (): void => undefined,
        gate: Promise.resolve(),
        started: 0,
    }
    const hold = (): void => {
        llm.mode = 'hold'
        llm.gate = new Promise<void>((resolve) => {
            llm.release = resolve
        })
    }
    const stream = async function* (): AsyncGenerator<string> {
        llm.started += 1
        if (llm.mode === 'fail') throw new Error('provider down')
        if (llm.mode === 'hold') await llm.gate
        yield 'Hello'
        yield ' there'
    }

    class Client extends WsTestClient {
        static connect(token: string): Promise<Client> {
            return WsTestClient.open((ws) => new Client(ws), PORT, token, clients)
        }

        chat(message: string, clientMessageId?: string): Promise<Frame> {
            return this.request('api/support/support_chat', {
                message,
                language: 'en',
                ...(clientMessageId !== undefined ? { clientMessageId } : {}),
            })
        }

        openChat(): Promise<Frame> {
            return this.request('api/support/support_open_chat', { language: 'en' })
        }
    }

    const insertUser = async () => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `support-adm-${String(counter)}`,
                email: `support-adm-${String(counter)}-${String(now)}@example.test`,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const connectedUser = async () => {
        const user = await insertUser()
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)
        await context.auth.login(String(user.id), user.sessionToken)
        const sessionInfo = context.session.sessionInfo
        if (sessionInfo === null) throw new Error('no session after login')
        const token = await generateWsToken(sessionInfo, String(user.id))
        return { user, client: await Client.connect(token) }
    }

    /** The reply is the admission verdict: `ok`, or the reason the message was refused. */
    const verdict = (frame: Frame): string => {
        const data = frame.data as { status?: string; reason?: string; code?: string } | null
        if (frame.error !== null && frame.error !== undefined) {
            return `error:${frame.error.code ?? '?'}`
        }
        if (data?.status === 'ok') return 'ok'
        return `${String(frame.status)}:${data?.reason ?? data?.code ?? '?'}`
    }

    const BROADCAST_COMPLETE = 'broadcast:support_chat_complete'
    const BROADCAST_ERROR = 'broadcast:support_chat_error'

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

        vi.spyOn(supportQueryTranslationService, 'translateToEnglish').mockImplementation(
            (message: string) => Promise.resolve(message),
        )
        vi.spyOn(supportEmbeddingService, 'search').mockResolvedValue([])
        vi.spyOn(supportLlmService, 'chatStream').mockImplementation(stream)
        vi.spyOn(supportLlmService, 'openChatStream').mockImplementation(stream)
    })

    afterEach(() => {
        llm.mode = 'finish'
        llm.release()
        llm.started = 0
    })

    afterAll(async () => {
        llm.release()
        for (const ws of clients) ws.close()
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

    it('answers ok and streams the reply for an ordinary message (the baseline)', async () => {
        const { client } = await connectedUser()

        expect(verdict(await client.chat('How do I change my avatar?'))).toBe('ok')

        await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
        expect(client.received('broadcast:support_chat_token')).toBe(2)
    })

    describe('length', () => {
        it('accepts a message of exactly the maximum length', async () => {
            const { client } = await connectedUser()

            const reply = await client.chat('a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH))

            expect(verdict(reply)).toBe('ok')
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
        })

        it('refuses a longer one with a validation error, never ok, and calls nothing', async () => {
            const { client } = await connectedUser()

            const reply = await client.chat('a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1))

            expect(verdict(reply)).toBe('error:validation_failed')
            await sleep(100)
            expect(llm.started).toBe(0)
        })
    })

    describe('frequency', () => {
        it('refuses the message over the per-user limit with 429, before ok', async () => {
            const { client } = await connectedUser()
            for (let i = 0; i < 3; i += 1) {
                expect(verdict(await client.chat(`message ${String(i)}`))).toBe('ok')
                await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
                client.frames.length = 0
            }
            llm.started = 0

            const reply = await client.chat('one too many')

            expect(verdict(reply)).toBe('429:support_rate_limited')
            await sleep(100)
            expect(llm.started).toBe(0)
        })

        it('counts per user: another user is not affected', async () => {
            const first = await connectedUser()
            const second = await connectedUser()
            for (let i = 0; i < 3; i += 1) {
                await first.client.chat(`message ${String(i)}`)
                await first.client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
                first.client.frames.length = 0
            }
            expect(verdict(await first.client.chat('over'))).toBe('429:support_rate_limited')

            expect(verdict(await second.client.chat('hello'))).toBe('ok')
        })

        it('has a separate, smaller limit for opening the chat', async () => {
            const { client } = await connectedUser()
            expect(verdict(await client.openChat())).toBe('ok')
            // Only the first greeting is written: later ones find a history and stay silent.
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
            expect(verdict(await client.openChat())).toBe('ok')

            expect(verdict(await client.openChat())).toBe('429:support_rate_limited')
        })
    })

    describe('one answer at a time', () => {
        it('refuses a second message while the first is being answered, then accepts one after', async () => {
            const { client } = await connectedUser()
            hold()
            expect(verdict(await client.chat('first'))).toBe('ok')
            await sleep(100)

            const busy = await client.chat('second')

            expect(verdict(busy)).toBe('429:support_busy')
            expect(llm.started).toBe(1)

            llm.release()
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
            llm.mode = 'finish'
            // At once, with no pause: the lock is released before the client is told the
            // answer is complete, so a client that sends its next message right away is not
            // told "busy".
            expect(verdict(await client.chat('third'))).toBe('ok')
        })

        it('shares the one answer with opening the chat', async () => {
            const { client } = await connectedUser()
            hold()
            expect(verdict(await client.chat('first'))).toBe('ok')
            await sleep(100)

            expect(verdict(await client.openChat())).toBe('429:support_busy')
        })

        it('does not block another user', async () => {
            const busy = await connectedUser()
            const other = await connectedUser()
            hold()
            expect(verdict(await busy.client.chat('first'))).toBe('ok')
            await sleep(100)

            expect(verdict(await other.client.chat('hello'))).toBe('ok')
        })
    })

    // Review of #208: the answer to a request can be lost (timeout, dropped connection) after
    // the server stored the message. The client then sends the same message with the same id;
    // that must not store it twice.
    describe('a resend with the same client message id', () => {
        const userMessages = async (userId: bigint) =>
            (
                await db
                    .select()
                    .from(supportChatHistory)
                    .where(eq(supportChatHistory.userId, userId))
            )
                .filter((row) => row.role === 'user')
                .map((row) => row.content)

        it('puts the id on the events of the answer', async () => {
            const { client } = await connectedUser()

            expect(verdict(await client.chat('hello', 'id-events'))).toBe('ok')
            const done = await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)

            expect(done.payload).toMatchObject({ clientMessageId: 'id-events' })
        })

        it('stores the message once, does not answer it twice, and tells the client', async () => {
            const { user, client } = await connectedUser()
            expect(verdict(await client.chat('hello', 'id-1'))).toBe('ok')
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
            const startedBefore = llm.started

            // The resend: admitted like any message, then recognised as already received.
            expect(verdict(await client.chat('hello', 'id-1'))).toBe('ok')
            const note = await client.waitFor((frame) => frame.event === BROADCAST_ERROR)

            expect(note.payload).toMatchObject({
                code: 'message_already_received',
                clientMessageId: 'id-1',
            })
            expect(await userMessages(user.id)).toEqual(['hello'])
            expect(llm.started).toBe(startedBefore)
            // The lock was released: the user is not stuck.
            expect(verdict(await client.chat('next', 'id-2'))).toBe('ok')
        })

        it('is refused as busy while the original is still being answered, and still stores it once', async () => {
            const { user, client } = await connectedUser()
            hold()
            expect(verdict(await client.chat('hello', 'id-busy'))).toBe('ok')
            await sleep(100)

            expect(verdict(await client.chat('hello', 'id-busy'))).toBe('429:support_busy')

            llm.release()
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)
            expect(await userMessages(user.id)).toEqual(['hello'])
        })

        it('treats a message with another id as a new message', async () => {
            const { user, client } = await connectedUser()
            expect(verdict(await client.chat('hello', 'id-a'))).toBe('ok')
            await client.waitFor((frame) => frame.event === BROADCAST_COMPLETE)

            expect(verdict(await client.chat('hello', 'id-b'))).toBe('ok')
            await client.waitFor(
                (frame) =>
                    frame.event === BROADCAST_COMPLETE && client.received(BROADCAST_COMPLETE) >= 2,
            )

            expect(await userMessages(user.id)).toEqual(['hello', 'hello'])
        })

        it('refuses an id with unsafe characters as a validation error', async () => {
            const { client } = await connectedUser()

            expect(verdict(await client.chat('hello', 'has space'))).toBe('error:validation_failed')
        })
    })

    describe('a failure after admission', () => {
        it('reaches the client as support_chat_error with a code and frees the user', async () => {
            const { client } = await connectedUser()
            llm.mode = 'fail'

            expect(verdict(await client.chat('hello'))).toBe('ok')
            const failure = await client.waitFor((frame) => frame.event === BROADCAST_ERROR)

            expect(failure.payload).toMatchObject({
                code: 'chat_failed',
                message: expect.any(String),
            })
            llm.mode = 'finish'
            expect(verdict(await client.chat('try again'))).toBe('ok')
        })
    })
})
