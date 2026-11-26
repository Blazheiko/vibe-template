import type { Redis } from 'ioredis'
import { ms, seconds, toSecondsCeil } from 'shared/brand'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import type { MfaTicketId } from '#app/domain/secrets.js'
import type { SessionInfo } from '#vendor/types/types.js'

// feat-270 (plan Р7, T39) on a real Redis: a key written through the typed TTL helpers, and by the
// writers that had no TTL test (the WS token, the passkey challenges), lives exactly as long as
// its unit says, never less.

const { PREFIX } = vi.hoisted(() => ({ PREFIX: `test:${crypto.randomUUID()}:` }))

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

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { setIfAbsentWithTtlMs, setWithTtlSeconds } = await import('./redis-ttl.js')
const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
const { passkeyLoginChallenges, passkeyTicketChallenges, ticketHash } =
    await import('#app/services/auth/mfa/passkey-login-challenges.js')

const admin = createTestRedis(PREFIX)

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('typed Redis TTL helpers', () => {
    it('setWithTtlSeconds writes an EX expiry in seconds', async () => {
        await setWithTtlSeconds(client, 'ttl:ex', 'v', seconds(120))
        const ttl = await admin.ttl('ttl:ex')
        expect(ttl).toBeGreaterThan(118)
        expect(ttl).toBeLessThanOrEqual(120)
    })

    it('a fractional duration rounded up by toSecondsCeil never ends early', async () => {
        await setWithTtlSeconds(client, 'ttl:ceil', 'v', toSecondsCeil(ms(1_500)))
        // 1.5 s becomes 2 s, not 1 s.
        expect(await admin.pttl('ttl:ceil')).toBeGreaterThan(1_500)
    })

    it('setIfAbsentWithTtlMs writes a PX expiry in milliseconds, only once', async () => {
        expect(await setIfAbsentWithTtlMs(client, 'ttl:px', 'a', ms(5_000))).toBe('OK')
        expect(await setIfAbsentWithTtlMs(client, 'ttl:px', 'b', ms(5_000))).toBeNull()
        const pttl = await admin.pttl('ttl:px')
        expect(pttl).toBeGreaterThan(4_000)
        expect(pttl).toBeLessThanOrEqual(5_000)
        expect(await admin.get('ttl:px')).toBe('a')
    })
})

describe.skipIf(!hasRedis)('writers without a TTL test before feat-270', () => {
    it('the WS token lives 60 seconds', async () => {
        const session = {
            id: 'session-1',
            data: { userId: '7', userToken: 'token-1' },
        } as unknown as SessionInfo
        const token = await generateWsToken(session, '7')
        expect(token).not.toBe('')
        const ttl = await admin.ttl(`auth:ws:${token}`)
        expect(ttl).toBeGreaterThan(58)
        expect(ttl).toBeLessThanOrEqual(60)
    })

    it('a passwordless challenge lives the configured challenge TTL (seconds)', async () => {
        const id = await passkeyLoginChallenges.issue('challenge-1')
        const ttl = await admin.ttl(`auth:webauthn:login:${id}`)
        expect(ttl).toBeGreaterThan(298)
        expect(ttl).toBeLessThanOrEqual(300)
    })

    it('a second-step challenge never outlives its ticket', async () => {
        const ticketId = 'ticket-ttl-test' as MfaTicketId
        await passkeyTicketChallenges.issue(ticketId, 'challenge-2', seconds(30))
        const ttl = await admin.ttl(`auth:webauthn:mfa:${ticketHash(ticketId)}`)
        expect(ttl).toBeGreaterThan(28)
        expect(ttl).toBeLessThanOrEqual(30)
    })
})
