import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    REDIS_TEST_URL,
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../test-support/redis-test-client.js'

vi.mock('#logger', () => ({ default: { warn: vi.fn() } }))

// The production client contract itself, not a stand-in: rateLimitRedisOptions
// (timeout, no offline queue, no resend, automatic reconnect) against a real server.
const { rateLimitRedisOptions } = await import('./redis-rate-limit.js')
const { host: _host, port: _port, ...contract } = rateLimitRedisOptions
const prefix = `test:${randomUUID()}:`

const INCR_LUA = "return redis.call('INCR', KEYS[1])"

const client = new Redis(REDIS_TEST_URL ?? 'redis://127.0.0.1:6379', {
    ...contract,
    keyPrefix: prefix,
})
// Admin connection: pauses writes and kills the client's connection.
const admin = createTestRedis(prefix)

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
        await sleep(20)
    }
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await admin.call('CLIENT', 'UNPAUSE')
    await cleanupTestRedis(admin)
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('rate-limit Redis client with production options', () => {
    it('uses the production contract', () => {
        expect(client.options).toMatchObject({
            enableOfflineQueue: false,
            maxRetriesPerRequest: 0,
            autoResendUnfulfilledCommands: false,
            commandTimeout: 500,
        })
    })

    it('fails a command after commandTimeout instead of waiting', async () => {
        // The pause outlasts the 500 ms timeout (feat-178): the command fails at the timeout.
        await admin.call('CLIENT', 'PAUSE', '1500', 'WRITE')
        const started = Date.now()
        await expect(client.eval(INCR_LUA, 1, 'timeout')).rejects.toThrow(/timed out/i)
        expect(Date.now() - started).toBeLessThan(1000)
        await admin.call('CLIENT', 'UNPAUSE')
    })

    it('does not resend an in-flight command after the connection drops, and reconnects by itself', async () => {
        await admin.call('CLIENT', 'PAUSE', '2000', 'WRITE')
        const id = String(await client.call('CLIENT', 'ID'))
        // Blocked server-side by the pause, so it is still unfulfilled when the socket dies.
        const inFlight = client.eval(INCR_LUA, 1, 'resend').catch((err: unknown) => err)
        await sleep(20)
        await admin.call('CLIENT', 'KILL', 'ID', id)
        await admin.call('CLIENT', 'UNPAUSE')

        expect(await inFlight).toBeInstanceOf(Error)
        // While reconnecting, commands fail fast rather than queue.
        if (client.status !== 'ready') {
            await expect(client.eval(INCR_LUA, 1, 'offline')).rejects.toThrow()
        }

        await waitFor(() => client.status === 'ready')
        // No resend: the killed command never reached Redis.
        expect(await admin.get('resend')).toBeNull()
        expect(await client.eval(INCR_LUA, 1, 'after')).toBe(1)
    })
})
