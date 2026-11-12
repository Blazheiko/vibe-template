import { connect, createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../test-support/redis-test-client.js'
import { WsTestClient } from '../../test-support/ws-test-client.js'

// feat-107 (R04) over real WebSocket connections: a real uWebSockets.js server with the real
// route tables, real sessions in Redis and real users in PostgreSQL. A page reload closes the old
// socket while its close handler still waits on Redis (the token revoke, held here) and opens a
// new one for the same user. Before feat-107 the dead socket was still in the registry, the new
// registration threw on it, and the new connection got no direct messages.

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

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
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
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))

describe.skipIf(!hasPg || !hasRedis)('WebSocket registry across a page reload', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { broadcastService } = await import('#app/services/communication/broadcast-service.js')
    const { wsConnectionRegistry } = await import('#app/websocket/ws-connection-registry.js')
    const { userOnlineService } = await import('#app/services/communication/user-online-service.js')
    const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')

    // Registers the WebSocket hooks, the message validator and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const createdUserIds: bigint[] = []
    const clients: WebSocket[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    let inserted = 0
    const insertUser = async () => {
        inserted += 1
        const [row] = await db
            .insert(users)
            .values({
                name: 'ws-reload',
                email: `ws-reload-${String(now)}-${String(inserted)}@example.test`,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const wsTokenFor = async (user: { id: bigint; sessionToken: string }): Promise<string> => {
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
        if (token === '') throw new Error('no ws token')
        return token
    }

    class Client extends WsTestClient {
        static connect(token: string): Promise<Client> {
            return WsTestClient.open((ws) => new Client(ws), PORT, token, clients)
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

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
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

    it('the new socket gets direct messages while the old close is still running', async () => {
        const user = await insertUser()
        const userId = String(user.id)
        const old = await Client.connect(await wsTokenFor(user))
        await sleep(100)
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)?.connectionsCount).toBe(1)

        // Hold the old socket's close handler in its user_online UPDATE (feat-196: there is no
        // WS token revoke at close any more, the upgrade consumed the token).
        const track = userOnlineService.trackDisconnected.bind(userOnlineService)
        let release: () => void = () => undefined
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        let closing: () => void = () => undefined
        const closeStarted = new Promise<void>((resolve) => {
            closing = resolve
        })
        vi.spyOn(userOnlineService, 'trackDisconnected').mockImplementation(async (input) => {
            closing()
            await held
            await track(input)
        })

        old.ws.close()
        await closeStarted
        // The old socket is already out of the registry, before its close finished.
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)).toBeUndefined()

        const fresh = await Client.connect(await wsTokenFor(user))
        await sleep(100)
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)?.connectionsCount).toBe(1)

        const sent = broadcastService.broadcastMessageToUser(userId, 'support_chat_token', {
            token: 'hello',
        })
        expect(sent).toBe(1)
        await fresh.waitFor((frame) => frame.event === 'broadcast:support_chat_token')

        release()
        await sleep(100)
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)?.connectionsCount).toBe(1)
    })

    // feat-196 (L-12): the token travels in Sec-WebSocket-Protocol, where proxies, extensions
    // and devtools see it. It used to be read with GET and kept alive by every message of the
    // first socket, so whoever saw it could open more sockets as the user, with no cookie.
    it('a WS token opens one connection: the second upgrade with it is refused', async () => {
        const user = await insertUser()
        const userId = String(user.id)
        const token = await wsTokenFor(user)

        const first = await Client.connect(token)
        await sleep(100)
        // The first socket is alive and has sent a message: nothing brings the token back.
        first.ws.send(
            JSON.stringify({ event: 'no/such/route', timestamp: Date.now(), payload: null }),
        )
        await sleep(50)

        await expect(Client.connect(token)).rejects.toThrow('websocket failed to open')
        expect(await admin.exists(`auth:ws:${token}`)).toBe(0)
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)?.connectionsCount).toBe(1)

        // A new token from the same session opens the next connection, as a reconnect does.
        await Client.connect(await wsTokenFor(user))
        await sleep(100)
        expect(wsConnectionRegistry.getOnlineUserMeta(userId)?.connectionsCount).toBe(2)
    })

    it('of two upgrades racing with one token exactly one opens', async () => {
        const user = await insertUser()
        const token = await wsTokenFor(user)

        const outcomes = await Promise.allSettled([Client.connect(token), Client.connect(token)])

        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    })

    // feat-112 (R08): the last case, it stops the server. Every socket gets 4201 and the listen
    // socket is closed before.
    it('stopServer closes every socket with 4201', async () => {
        const first = await insertUser()
        const firstClient = await Client.connect(await wsTokenFor(first))
        const secondClient = await Client.connect(await wsTokenFor(first))
        const codes: number[] = []
        for (const client of [firstClient, secondClient]) {
            client.ws.addEventListener('close', (event) => {
                codes.push(event.code)
            })
        }
        await stopServer?.('test')
        await sleep(200)

        expect(codes.sort()).toEqual([4201, 4201])
        const refused = await new Promise<string>((resolve) => {
            const socket = connect(PORT, '127.0.0.1')
            socket.once('connect', () => {
                socket.destroy()
                resolve('connected')
            })
            socket.once('error', (err: NodeJS.ErrnoException) => {
                resolve(err.code ?? 'error')
            })
        })
        expect(refused).toBe('ECONNREFUSED')
    })
})
