import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    REDIS_TEST_URL,
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../test-support/redis-test-client.js'
import { readBlockedClients, waitForPostponed } from '../test-support/redis-postponed.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// The session storage runs on a client with the production contract
// (mainRedisOptions: no offline queue, no resend, command timeout) and the real
// health module and withRedis, pointed at the test server and a test prefix.
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('./redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('./redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: `test:${crypto.randomUUID()}:`,
        lazyConnect: true,
    })
    const healthLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const redisHealth = createRedisHealth(client, { logger: healthLogger })
    return {
        default: client,
        redisHealth,
        withRedis: createWithRedis(client, redisHealth),
        healthLogger,
    }
})

const mocked = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { state: string; stop(): void }
    withRedis: <T>(op: () => Promise<T>) => Promise<T>
    healthLogger: Record<'error' | 'warn' | 'info', ReturnType<typeof vi.fn>>
}
const { default: client, redisHealth, withRedis, healthLogger } = mocked
const storage = await import('#vendor/utils/session/redis-session-storage.js')
const { mainRedisOptions } = await import('./redis-main-options.js')

const prefix = client.options.keyPrefix ?? ''
const admin = createTestRedis(prefix)
// Control: everything ioredis does by default to retry a command.
const control = new Redis(REDIS_TEST_URL ?? 'redis://127.0.0.1:6379', {
    keyPrefix: prefix,
    lazyConnect: true,
    enableOfflineQueue: true,
    autoResendUnfulfilledCommands: true,
    maxRetriesPerRequest: null,
    commandTimeout: 10_000,
    retryStrategy: () => 50,
})

const USER_TOKEN = 'u0123456789abcdef'
const sessionKey = (id: string): string => `session:${USER_TOKEN}:${id}`
const session = (id: string, value: string) => ({
    id,
    data: { userToken: USER_TOKEN, value },
    // Now, not a fixed date: a record older than SESSION_MAX_AGE_DAYS is refused by getSession
    // (feat-119), so a fixed date made these tests fail 30 days after it.
    createdAt: new Date().toISOString(),
})

const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    what: string,
    timeoutMs = 5_000,
): Promise<void> => {
    const start = Date.now()
    while (!(await predicate())) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
        await sleep(20)
    }
}

const pause = (): Promise<unknown> => admin.call('CLIENT', 'PAUSE', '10000', 'WRITE')
const unpause = (): Promise<unknown> => admin.call('CLIENT', 'UNPAUSE')

/**
 * Starts `op` under CLIENT PAUSE WRITE, waits until its command is postponed on
 * the server (not just sent), kills the connection, unpauses and waits for the
 * reconnect. Resolves with the operation's outcome ("ok" or the error).
 */
const postponeAndKill = async (
    target: Redis,
    cmd: string,
    op: () => Promise<unknown>,
): Promise<unknown> => {
    const id = await target.client('ID')
    const blockedBefore = await readBlockedClients(admin)
    await pause()
    const outcome = op().then(
        () => 'ok',
        (err: unknown) => err,
    )
    const reconnected = new Promise((resolve) => target.once('ready', resolve))
    try {
        await waitForPostponed(admin, id, cmd, { blockedBefore })
        await admin.call('CLIENT', 'KILL', 'ID', String(id))
    } finally {
        await unpause()
    }
    await reconnected
    return outcome
}

const exists = async (key: string): Promise<boolean> => (await admin.exists(key)) === 1

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
    await control.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await unpause()
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    control.disconnect(false)
    await admin.quit()
})
beforeEach(async () => {
    if (!hasRedis) return
    await waitFor(() => client.status === 'ready', 'main client ready')
    // Settle health from the previous test before counting events.
    await withRedis(() => client.ping())
    vi.clearAllMocks()
})

describe.skipIf(!hasRedis)('main Redis client against a real server', () => {
    it('uses the production contract', () => {
        expect(client.options).toMatchObject({
            enableOfflineQueue: false,
            autoResendUnfulfilledCommands: false,
            maxRetriesPerRequest: 0,
            commandTimeout: mainRedisOptions.commandTimeout,
        })
    })

    describe('waitForPostponed', () => {
        it("sees a postponed SETEX by the client's blocked flag", async () => {
            const id = await control.client('ID')
            await pause()
            const pending = control.setex('probe', 10, 'v')
            try {
                await expect(waitForPostponed(admin, id, 'setex')).resolves.toBe('flag')
            } finally {
                await unpause()
            }
            await pending
        })

        it('falls back to blocked_clients when the flag signal is off', async () => {
            const id = await control.client('ID')
            const blockedBefore = await readBlockedClients(admin)
            await pause()
            const pending = control.setex('probe', 10, 'v')
            try {
                await expect(
                    waitForPostponed(admin, id, 'setex', {
                        blockedBefore,
                        signals: ['blocked_clients'],
                    }),
                ).resolves.toBe('blocked_clients')
            } finally {
                await unpause()
            }
            await pending
        })

        it('fails with an explicit message when nothing is postponed', async () => {
            const id = await control.client('ID')
            await expect(waitForPostponed(admin, id, 'setex', { timeoutMs: 200 })).rejects.toThrow(
                /was not seen postponed/,
            )
        })
    })

    describe('no resend after a dropped connection', () => {
        it('control: default ioredis retries resend the SETEX after reconnect', async () => {
            const outcome = await postponeAndKill(control, 'setex', () =>
                control.setex(sessionKey('control-write'), 60, 'v'),
            )
            expect(outcome).toBe('ok')
            expect(await exists(sessionKey('control-write'))).toBe(true)
        })

        it('saveSession is not resent: the key never appears', async () => {
            // feat-272: saveSession writes SET … EX through the typed TTL helper.
            const outcome = await postponeAndKill(client, 'set', () =>
                storage.saveSession(session('write', 'A')),
            )
            expect(outcome).toBeInstanceOf(RedisUnavailableError)
            await sleep(300)
            expect(await exists(sessionKey('write'))).toBe(false)
        })

        it('control: default ioredis retries resend the DEL after reconnect', async () => {
            await admin.setex(sessionKey('control-del'), 60, 'v')
            await postponeAndKill(control, 'del', () => control.del(sessionKey('control-del')))
            expect(await exists(sessionKey('control-del'))).toBe(false)
        })

        it('destroySession is not resent: the session stays until a repeated logout', async () => {
            await storage.saveSession(session('logout', 'A'))
            // feat-233: a signed-in session is deleted with its index member by one script.
            const outcome = await postponeAndKill(client, 'eval', () =>
                storage.destroySession('logout', USER_TOKEN),
            )
            expect(outcome).toBeInstanceOf(RedisUnavailableError)
            await sleep(300)
            expect(await exists(sessionKey('logout'))).toBe(true)

            await storage.destroySession('logout', USER_TOKEN)
            expect(await exists(sessionKey('logout'))).toBe(false)
        })

        it('a stale SET … EX snapshot does not overwrite the session', async () => {
            await storage.saveSession(session('stale', 'V0'))
            await postponeAndKill(client, 'set', () => storage.saveSession(session('stale', 'A')))
            await sleep(300)
            expect((await storage.getSession('stale', USER_TOKEN))?.data['value']).toBe('V0')

            await storage.saveSession(session('stale', 'B'))
            expect((await storage.getSession('stale', USER_TOKEN))?.data['value']).toBe('B')
        })
    })

    it('late execution (documented): a timed-out SET … EX still runs after UNPAUSE', async () => {
        await pause()
        try {
            await expect(storage.saveSession(session('late', 'A'))).rejects.toBeInstanceOf(
                RedisUnavailableError,
            )
            expect(await exists(sessionKey('late'))).toBe(false)
        } finally {
            await unpause()
        }
        await waitFor(() => exists(sessionKey('late')), 'the postponed SET … EX')
    })

    it('health: one event per incident, recovery without a reconnect', async () => {
        await pause()
        try {
            await expect(storage.saveSession(session('health', 'A'))).rejects.toBeInstanceOf(
                RedisUnavailableError,
            )
            await expect(storage.saveSession(session('health', 'B'))).rejects.toBeInstanceOf(
                RedisUnavailableError,
            )
            expect(redisHealth.state).toBe('unavailable')
            expect(healthLogger.error).toHaveBeenCalledTimes(1)
            expect(healthLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ sentryCapture: true }),
                'Redis unavailable',
            )
        } finally {
            await unpause()
        }

        await storage.saveSession(session('health', 'C'))
        expect(redisHealth.state).toBe('healthy')
        expect(healthLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({ downMs: expect.any(Number) }),
            'Redis recovered',
        )

        await pause()
        try {
            await expect(storage.saveSession(session('health', 'D'))).rejects.toBeInstanceOf(
                RedisUnavailableError,
            )
        } finally {
            await unpause()
        }
        expect(healthLogger.error).toHaveBeenCalledTimes(2)
    })

    it('dropped connection: commands fail at once, the client reconnects by itself', async () => {
        const id = await client.client('ID')
        await admin.call('CLIENT', 'KILL', 'ID', String(id))
        await waitFor(() => client.status !== 'ready', 'disconnect')

        const start = Date.now()
        await expect(storage.getSession('gone', USER_TOKEN)).rejects.toBeInstanceOf(
            RedisUnavailableError,
        )
        expect(Date.now() - start).toBeLessThan(100)

        await waitFor(() => client.status === 'ready', 'reconnect')
        await expect(storage.getSession('gone', USER_TOKEN)).resolves.toBeNull()
    })

    it('a paused write fails after about the command timeout', async () => {
        const timeout = mainRedisOptions.commandTimeout
        await pause()
        const start = Date.now()
        try {
            await expect(storage.saveSession(session('slow', 'A'))).rejects.toBeInstanceOf(
                RedisUnavailableError,
            )
        } finally {
            await unpause()
        }
        const elapsed = Date.now() - start
        expect(elapsed).toBeGreaterThanOrEqual(timeout - 20)
        expect(elapsed).toBeLessThan(timeout + 500)
    })
})
