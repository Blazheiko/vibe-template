import type { Redis } from 'ioredis'
import type { MfaTicketId } from '#app/domain/secrets.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MfaTicket as Ticket } from './mfa-ticket.js'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, tasks M8) on a real Redis: the second-step ticket
// counts confirmed failures apart from the attempts in flight, lets one attempt win, refuses an
// attempt whose reservation lapsed, and goes back to `open` after a known rollback.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})
const silent = vi.hoisted(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: (): unknown => silent,
}))
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
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
const {
    mfaTicketStore: brandedTicketStore,
    MFA_MAX_FAILURES,
    newTicketId,
} = await import('./mfa-ticket.js')

// feat-265: the store takes branded ids (MfaTicketId, MfaReservationId…); this suite names them
// with short literals, so it sees the store with its string parameters widened to string.
type Widen<T> = T extends string
    ? string
    : T extends (infer E)[]
      ? Widen<E>[]
      : T extends object
        ? { [K in keyof T]: Widen<T[K]> }
        : T
type Loose<F> = F extends (...args: infer A) => infer R
    ? (...args: { [K in keyof A]: Widen<A[K]> }) => R
    : F
type LooseStore = { [K in keyof typeof brandedTicketStore]: Loose<(typeof brandedTicketStore)[K]> }
const mfaTicketStore = brandedTicketStore as unknown as LooseStore
const { passkeyTicketChallenges } = await import('./passkey-login-challenges.js')

const admin = createTestRedis(PREFIX)
const TTL_MS = 30_000
const NOW = 1_800_000_000_000

const ticket = (): Ticket => ({
    v: 1,
    state: 'open',
    userId: '7',
    userTokenAtStart: 'token-at-start-1',
    binding: 'browser-a',
    origin: { method: 'password' },
    firstFactor: 'pwd',
    failures: 0,
    reservations: [],
    settled: [],
})

const plan = {
    sessionId: 's-1',
    userId: '7',
    expectedUserToken: 'token-at-start-1',
    device: {
        publicId: 'p',
        ip: '1.1.1.1',
        userAgent: 'ua',
        method: 'password' as const,
        signedInAt: new Date(NOW).toISOString(),
    },
    auth: {
        v: 1 as const,
        amr: ['pwd' as const, 'otp' as const],
        aal: 2 as const,
        authenticatedAt: new Date(NOW).toISOString(),
        verified: { pwd: new Date(NOW).toISOString() },
    },
    createdAtMs: NOW,
}

const open = async (): Promise<MfaTicketId> => {
    const id = newTicketId()
    await mfaTicketStore.create(id, ticket(), 300)
    return id
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
beforeEach(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('MFA ticket store (feat-245 M8)', () => {
    it('another browser, or no ticket, is invalid', async () => {
        const id = await open()
        expect((await mfaTicketStore.reserve(id, 'browser-b', 'r', NOW, TTL_MS)).kind).toBe(
            'invalid',
        )
        expect(
            (await mfaTicketStore.reserve(newTicketId(), 'browser-a', 'r', NOW, TTL_MS)).kind,
        ).toBe('invalid')
    })

    it('five confirmed failures delete the ticket; a sixth attempt in flight is refused without deleting', async () => {
        const id = await open()
        const ids = ['r1', 'r2', 'r3', 'r4', 'r5']
        for (const r of ids) {
            expect((await mfaTicketStore.reserve(id, 'browser-a', r, NOW, TTL_MS)).kind).toBe('ok')
        }
        // Five in flight: a sixth is refused, the ticket stays.
        expect((await mfaTicketStore.reserve(id, 'browser-a', 'r6', NOW, TTL_MS)).kind).toBe('busy')
        expect(await mfaTicketStore.read(id)).not.toBeNull()
        // The one that reserved last fails first: nothing is deleted yet.
        expect(await mfaTicketStore.settle(id, 'r5', 'failure')).toBe('ok')
        for (const r of ['r1', 'r2', 'r3']) {
            expect(await mfaTicketStore.settle(id, r, 'failure')).toBe('ok')
        }
        expect(await mfaTicketStore.read(id)).not.toBeNull()
        expect(await mfaTicketStore.settle(id, 'r4', 'failure')).toBe('deleted')
        expect(await mfaTicketStore.read(id)).toBeNull()
        expect(MFA_MAX_FAILURES).toBe(5)
    })

    it('among five in flight, a right proof wins even after four failures', async () => {
        const id = await open()
        for (const r of ['r1', 'r2', 'r3', 'r4', 'r5']) {
            await mfaTicketStore.reserve(id, 'browser-a', r, NOW, TTL_MS)
        }
        for (const r of ['r1', 'r2', 'r3', 'r4']) await mfaTicketStore.settle(id, r, 'failure')
        expect(
            await mfaTicketStore.capture(id, 'r5', NOW, TTL_MS, {
                completionId: 'c',
                xid: '100',
                plan,
            }),
        ).toBe('ok')
        const stored = await mfaTicketStore.read(id)
        expect(stored?.state).toBe('completing')
        expect(stored?.plan?.sessionId).toBe('s-1')
        expect(stored?.plan?.auth.verified).toEqual(plan.auth.verified)
    })

    it('a release gives the place back: an infrastructure failure on the fifth attempt can be repeated', async () => {
        const id = await open()
        for (const r of ['r1', 'r2', 'r3', 'r4']) {
            await mfaTicketStore.reserve(id, 'browser-a', r, NOW, TTL_MS)
            await mfaTicketStore.settle(id, r, 'failure')
        }
        await mfaTicketStore.reserve(id, 'browser-a', 'r5', NOW, TTL_MS)
        expect(await mfaTicketStore.settle(id, 'r5', 'release')).toBe('ok')
        // A second account of the same reservation changes nothing.
        expect(await mfaTicketStore.settle(id, 'r5', 'failure')).toBe('settled')
        expect((await mfaTicketStore.reserve(id, 'browser-a', 'r6', NOW, TTL_MS)).kind).toBe('ok')
        expect(
            await mfaTicketStore.capture(id, 'r6', NOW, TTL_MS, {
                completionId: 'c',
                xid: '1',
                plan,
            }),
        ).toBe('ok')
    })

    it('an abandoned reservation frees its place; a lapsed one cannot win', async () => {
        const id = await open()
        for (const r of ['r1', 'r2', 'r3', 'r4', 'r5']) {
            await mfaTicketStore.reserve(id, 'browser-a', r, NOW, TTL_MS)
        }
        const later = NOW + TTL_MS + 1
        expect((await mfaTicketStore.reserve(id, 'browser-a', 'r6', later, TTL_MS)).kind).toBe('ok')
        expect(
            await mfaTicketStore.capture(id, 'r1', later, TTL_MS, {
                completionId: 'c',
                xid: '1',
                plan,
            }),
        ).toBe('expired')
        // A wrong proof of a lapsed reservation still counts.
        await mfaTicketStore.settle(id, 'r2', 'failure')
        expect((await mfaTicketStore.read(id))?.failures).toBe(1)
    })

    it('one winner of two captures; a known rollback reopens the ticket', async () => {
        const id = await open()
        await mfaTicketStore.reserve(id, 'browser-a', 'a', NOW, TTL_MS)
        await mfaTicketStore.reserve(id, 'browser-a', 'b', NOW, TTL_MS)
        const results = await Promise.all([
            mfaTicketStore.capture(id, 'a', NOW, TTL_MS, { completionId: 'ca', xid: '1', plan }),
            mfaTicketStore.capture(id, 'b', NOW, TTL_MS, { completionId: 'cb', xid: '2', plan }),
        ])
        expect(results.sort()).toEqual(['ok', 'used'])
        const winner = (await mfaTicketStore.read(id))?.completionId ?? ''
        expect(await mfaTicketStore.reopen(id, 'not-this-one')).toBe('no')
        expect(await mfaTicketStore.reopen(id, winner)).toBe('reopened')
        const reopened = await mfaTicketStore.read(id)
        expect(reopened?.state).toBe('open')
        expect(reopened?.plan).toBeUndefined()
        expect(reopened?.failures).toBe(0)
    })

    it('a reserve on a completing or activated ticket answers its state', async () => {
        const id = await open()
        await mfaTicketStore.reserve(id, 'browser-a', 'a', NOW, TTL_MS)
        await mfaTicketStore.capture(id, 'a', NOW, TTL_MS, { completionId: 'c', xid: '9', plan })
        const outcome = await mfaTicketStore.reserve(id, 'browser-a', 'z', NOW, TTL_MS)
        expect(outcome.kind).toBe('completing')
        if (outcome.kind === 'completing') expect(outcome.ticket.xid).toBe('9')
        // Another completion's ticket (a newer second step) is left as it is.
        expect(await mfaTicketStore.retire(id, 'other')).toBe('foreign')
        expect((await mfaTicketStore.read(id))?.state).toBe('completing')
        expect(await mfaTicketStore.retire(id, 'c')).toBe('retired')
        expect(await mfaTicketStore.read(id)).toBeNull()
        expect(await mfaTicketStore.retire(id, 'c')).toBe('absent')
    })

    // feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 1): a late failure never removes a
    // ticket an attempt captured; a confirmed rollback deletes it at the limit.
    it('a late fifth failure on a captured ticket counts but keeps it; the rollback deletes it', async () => {
        const id = await open()
        for (const r of ['r1', 'r2', 'r3', 'r4']) {
            await mfaTicketStore.reserve(id, 'browser-a', r, NOW, TTL_MS)
            await mfaTicketStore.settle(id, r, 'failure')
        }
        // r5 reserved, then abandoned (lapsed); w wins later.
        await mfaTicketStore.reserve(id, 'browser-a', 'r5', NOW, TTL_MS)
        const later = NOW + TTL_MS + 1
        expect((await mfaTicketStore.reserve(id, 'browser-a', 'w', later, TTL_MS)).kind).toBe('ok')
        expect(
            await mfaTicketStore.capture(id, 'w', later, TTL_MS, {
                completionId: 'cw',
                xid: '5',
                plan,
            }),
        ).toBe('ok')
        // The late result of r5: counted, the captured ticket stays for its activation.
        expect(await mfaTicketStore.settle(id, 'r5', 'failure')).toBe('ok')
        const kept = await mfaTicketStore.read(id)
        expect(kept?.state).toBe('completing')
        expect(kept?.failures).toBe(MFA_MAX_FAILURES)
        // Its transaction rolled back after all: back to open would be at the limit, so it goes.
        expect(await mfaTicketStore.reopen(id, 'cw')).toBe('deleted')
        expect(await mfaTicketStore.read(id)).toBeNull()
    })

    it('deleteIfOpen deletes an open ticket of this browser only', async () => {
        const id = await open()
        expect(await mfaTicketStore.deleteIfOpen(id, 'browser-b')).toBe('absent')
        await mfaTicketStore.reserve(id, 'browser-a', 'a', NOW, TTL_MS)
        await mfaTicketStore.capture(id, 'a', NOW, TTL_MS, { completionId: 'c', xid: '1', plan })
        expect(await mfaTicketStore.deleteIfOpen(id, 'browser-a')).toBe('completing')
        expect((await mfaTicketStore.read(id))?.state).toBe('completing')
        const other = await open()
        expect(await mfaTicketStore.deleteIfOpen(other, 'browser-a')).toBe('deleted')
        expect(await mfaTicketStore.read(other)).toBeNull()
        expect(await mfaTicketStore.deleteIfOpen(other, 'browser-a')).toBe('absent')
    })

    // feat-256 (item 6): a failure counted once per logical attempt.
    it('a repeat of a counted attempt counts nothing and is refused before a reservation', async () => {
        const id = await open()
        await mfaTicketStore.reserve(id, 'browser-a', 'r1', NOW, TTL_MS, 'attempt-1')
        expect(await mfaTicketStore.settle(id, 'r1', 'failure', { attemptId: 'attempt-1' })).toBe(
            'ok',
        )
        // The answer was lost; the browser repeats the same request (the same attempt).
        expect(
            (await mfaTicketStore.reserve(id, 'browser-a', 'r2', NOW, TTL_MS, 'attempt-1')).kind,
        ).toBe('failed')
        // A request of that attempt still running settles its own reservation, counted once.
        await mfaTicketStore.reserve(id, 'browser-a', 'r3', NOW, TTL_MS, 'attempt-2')
        expect(await mfaTicketStore.settle(id, 'r3', 'failure', { attemptId: 'attempt-1' })).toBe(
            'ok',
        )
        const after = await mfaTicketStore.read(id)
        expect(after?.failures).toBe(1)
        expect(after?.failedAttempts).toEqual(['attempt-1'])
        expect(after?.reservations).toEqual([])
    })

    it('an attempt not counted yet (its settle never ran) counts on the repeat; a release does not block it', async () => {
        const id = await open()
        // The first request reserved; its count failed before it applied (no settle ran).
        await mfaTicketStore.reserve(id, 'browser-a', 'r1', NOW, TTL_MS, 'attempt-1')
        // The repeat replaces the live reservation of the same attempt: one place per attempt.
        await mfaTicketStore.reserve(id, 'browser-a', 'r2', NOW, TTL_MS, 'attempt-1')
        expect((await mfaTicketStore.read(id))?.reservations.map((r) => r.id)).toEqual(['r2'])
        // The repeat was throttled: a release, nothing counted, the attempt may come again.
        expect(await mfaTicketStore.settle(id, 'r2', 'release', { attemptId: 'attempt-1' })).toBe(
            'ok',
        )
        await mfaTicketStore.reserve(id, 'browser-a', 'r3', NOW, TTL_MS, 'attempt-1')
        expect(await mfaTicketStore.settle(id, 'r3', 'failure', { attemptId: 'attempt-1' })).toBe(
            'ok',
        )
        // A new submission of the same code is a new attempt: counted on its own.
        await mfaTicketStore.reserve(id, 'browser-a', 'r4', NOW, TTL_MS, 'attempt-2')
        await mfaTicketStore.settle(id, 'r4', 'failure', { attemptId: 'attempt-2' })
        expect((await mfaTicketStore.read(id))?.failures).toBe(2)
    })

    it('a passkey failure spends the checked challenge only while it is current; a replaced one is stale', async () => {
        const id = await open()
        const challenge = (value: string) => ({ key: passkeyTicketChallenges.keyOf(id), value })
        await passkeyTicketChallenges.issue(id, 'challenge-1', 300)
        await mfaTicketStore.reserve(id, 'browser-a', 'r1', NOW, TTL_MS, 'a1')
        // New options replaced the challenge between the check and the count: nothing counted.
        await passkeyTicketChallenges.issue(id, 'challenge-2', 300)
        expect(
            await mfaTicketStore.settle(id, 'r1', 'failure', {
                attemptId: 'a1',
                challenge: challenge('challenge-1'),
            }),
        ).toBe('stale')
        expect((await mfaTicketStore.read(id))?.failures).toBe(0)
        expect(await passkeyTicketChallenges.peek(id)).toBe('challenge-2')
        // The current one: counted and spent in the same step.
        await mfaTicketStore.reserve(id, 'browser-a', 'r2', NOW, TTL_MS, 'a2')
        expect(
            await mfaTicketStore.settle(id, 'r2', 'failure', {
                attemptId: 'a2',
                challenge: challenge('challenge-2'),
            }),
        ).toBe('ok')
        expect(await passkeyTicketChallenges.peek(id)).toBeNull()
        expect((await mfaTicketStore.read(id))?.failures).toBe(1)
    })

    it('a passkey capture needs the checked challenge and spends it', async () => {
        const id = await open()
        const challenge = (value: string) => ({ key: passkeyTicketChallenges.keyOf(id), value })
        await passkeyTicketChallenges.issue(id, 'c-1', 300)
        await mfaTicketStore.reserve(id, 'browser-a', 'a', NOW, TTL_MS)
        await mfaTicketStore.reserve(id, 'browser-a', 'b', NOW, TTL_MS)
        const completion = { completionId: 'cb', xid: '1', plan }
        expect(
            await mfaTicketStore.capture(id, 'a', NOW, TTL_MS, completion, challenge('other')),
        ).toBe('stale')
        expect((await mfaTicketStore.read(id))?.state).toBe('open')
        expect(
            await mfaTicketStore.capture(id, 'b', NOW, TTL_MS, completion, challenge('c-1')),
        ).toBe('ok')
        expect(await passkeyTicketChallenges.peek(id)).toBeNull()
    })
})
