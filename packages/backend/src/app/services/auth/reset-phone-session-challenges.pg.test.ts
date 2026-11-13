import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Result } from 'better-result'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-204 (security review 2026-11-12, L-3) against a real PostgreSQL: a phone reset
// challenge belongs to a browser session and lives next to the challenge of another session,
// at most two per number. Nobody retires a challenge they did not start.
describe.skipIf(!hasPg)('phone reset challenges per session on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { smsAuthChallenges } = await import('#database/schema.js')
    const { openSessionChallenge, SESSION_CHALLENGES_FULL } = await import('./sms-challenge.js')

    const phones: string[] = []
    let counter = 0
    const newPhone = (): string => {
        counter += 1
        const phone = `+1557${String((Date.now() + counter) % 10_000_000).padStart(7, '0')}`
        phones.push(phone)
        return phone
    }

    afterAll(async () => {
        if (phones.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.phone, phones))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    const start = (phone: string, sessionId: string | null) =>
        openSessionChallenge({
            phone,
            flow: 'reset_phone',
            metadata: sessionId === null ? {} : { sessionId },
            sessionId,
            maxLive: 2,
        })

    /** What the code does once the resend cooldown of the number has passed. */
    const cooldownPassed = async (phone: string): Promise<void> => {
        await db
            .update(smsAuthChallenges)
            .set({ resendAvailableAt: new Date(Date.now() - 1000) })
            .where(eq(smsAuthChallenges.phone, phone))
    }

    const live = async (phone: string): Promise<{ id: string; session: unknown }[]> => {
        const rows = await db
            .select()
            .from(smsAuthChallenges)
            .where(
                and(
                    eq(smsAuthChallenges.phone, phone),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
        return rows
            .map((row) => ({
                id: row.id,
                session: (row.metadata as { sessionId?: string } | null)?.sessionId ?? null,
            }))
            .sort((a, b) => String(a.session).localeCompare(String(b.session)))
    }

    const idOf = (result: Awaited<ReturnType<typeof start>>): string => {
        if (Result.isError(result) || result.value === SESSION_CHALLENGES_FULL) {
            throw new Error('no challenge was opened')
        }
        return result.value.id
    }

    it('a second session opens its own challenge and the first one stays', async () => {
        const phone = newPhone()
        const first = idOf(await start(phone, 'session-a'))
        await cooldownPassed(phone)

        const second = idOf(await start(phone, 'session-b'))

        expect(second).not.toBe(first)
        expect(await live(phone)).toEqual([
            { id: first, session: 'session-a' },
            { id: second, session: 'session-b' },
        ])
    })

    it('a third session opens nothing while two are live', async () => {
        const phone = newPhone()
        const first = idOf(await start(phone, 'session-a'))
        await cooldownPassed(phone)
        const second = idOf(await start(phone, 'session-b'))
        await cooldownPassed(phone)

        const third = await start(phone, 'session-c')
        const anonymous = await start(phone, null)

        expect(Result.isOk(third) && third.value).toBe(SESSION_CHALLENGES_FULL)
        expect(Result.isOk(anonymous) && anonymous.value).toBe(SESSION_CHALLENGES_FULL)
        expect((await live(phone)).map((row) => row.id).sort()).toEqual([first, second].sort())
    })

    it('a session that starts again replaces only its own challenge', async () => {
        const phone = newPhone()
        const first = idOf(await start(phone, 'session-a'))
        await cooldownPassed(phone)
        const second = idOf(await start(phone, 'session-b'))
        await cooldownPassed(phone)

        const again = idOf(await start(phone, 'session-a'))

        expect(again).not.toBe(first)
        expect(await live(phone)).toEqual([
            { id: again, session: 'session-a' },
            { id: second, session: 'session-b' },
        ])
    })

    it('answers the resend cooldown of the number to whoever starts too early', async () => {
        const phone = newPhone()
        idOf(await start(phone, 'session-a'))

        const early = await start(phone, 'session-b')

        expect(Result.isError(early) && early.error).toMatchObject({
            reason: 'resend_cooldown_active',
        })
        expect(await live(phone)).toHaveLength(1)
    })

    it('an expired challenge of another session does not count and is retired', async () => {
        const phone = newPhone()
        const first = idOf(await start(phone, 'session-a'))
        await cooldownPassed(phone)
        const expired = idOf(await start(phone, 'session-b'))
        await db
            .update(smsAuthChallenges)
            .set({ expiresAt: new Date(Date.now() - 1000), resendAvailableAt: new Date(0) })
            .where(eq(smsAuthChallenges.id, expired))
        await cooldownPassed(phone)

        const third = idOf(await start(phone, 'session-c'))

        expect(await live(phone)).toEqual([
            { id: first, session: 'session-a' },
            { id: third, session: 'session-c' },
        ])
    })

    it('three sessions starting at once never leave more than two live challenges', async () => {
        const phone = newPhone()
        idOf(await start(phone, 'session-a'))
        await cooldownPassed(phone)

        const results = await Promise.all([
            start(phone, 'session-b'),
            start(phone, 'session-c'),
            start(phone, 'session-d'),
        ])

        // The advisory lock lets them in one at a time: the first opens, the rest see its
        // resend cooldown.
        const opened = results.filter(
            (result) => Result.isOk(result) && result.value !== SESSION_CHALLENGES_FULL,
        )
        expect(opened).toHaveLength(1)
        expect(await live(phone)).toHaveLength(2)
    })
})
