import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../test-support/redis-test-client.js'

// feat-270 (plan Р13, T15) on a real Redis: a WS token record whose userId is not a row id opens
// no socket, even when a session record with the same userId exists and its sessionToken is
// current (the case where only the later checks would have refused it, or none).

const { PREFIX } = vi.hoisted(() => ({ PREFIX: `test:${crypto.randomUUID()}:` }))

vi.mock('#logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
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
const checkSessionToken = vi.hoisted(() => vi.fn())
vi.mock('#app/services/auth/session-token-check.js', () => ({ checkSessionToken }))

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { wsSessionAuth } = await import('./ws-session-auth.js')

const admin = createTestRedis(PREFIX)
let n = 0

/** A WS token record and the session it points to, both carrying `userId`. */
async function arrange(userId: unknown): Promise<string> {
    n += 1
    const token = `ws-token-${String(n)}`
    const sessionId = `s-${String(n)}`
    await admin.set(
        `auth:ws:${token}`,
        JSON.stringify({ sessionId, userId, userToken: 'u1' }),
        'EX',
        60,
    )
    await admin.set(
        `session:u1:${sessionId}`,
        JSON.stringify({ id: sessionId, data: { userId }, createdAt: new Date().toISOString() }),
        'EX',
        60,
    )
    return token
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
beforeEach(() => {
    checkSessionToken.mockReset()
    checkSessionToken.mockResolvedValue('ok')
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('verifyUpgradeToken: the userId of the token record', () => {
    it.each([['abc'], ['0'], ['007'], [7]])('refuses %j and spends the token', async (userId) => {
        const token = await arrange(userId)

        await expect(wsSessionAuth.verifyUpgradeToken(token)).resolves.toEqual({
            kind: 'missing',
        })
        expect(checkSessionToken).not.toHaveBeenCalled()
        expect(await admin.exists(`auth:ws:${token}`)).toBe(0)
    })

    it('opens the socket for a row id', async () => {
        const token = await arrange('42')

        await expect(wsSessionAuth.verifyUpgradeToken(token)).resolves.toMatchObject({
            kind: 'ok',
            userId: '42',
            userToken: 'u1',
        })
        expect(checkSessionToken).toHaveBeenCalledWith(42n, 'u1')
    })
})
