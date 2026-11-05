import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Result } from 'better-result'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../test-support/race-barrier.js'

// feat-134 (L2): two starts for one phone both passed the resend cooldown (each read "nothing
// pending"), then each retired the pending challenges and created its own; in the order
// read, read, retire, retire, create, create both stayed live (two SMS, a double budget of tries).
// The barrier holds both after that read; the advisory lock in openChallenge lets one through.
describe.skipIf(!hasPg)('two SMS starts for one phone on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { smsAuthChallenges } = await import('#database/schema.js')
    const { smsAuthChallengeRepository } = await import('#app/repositories/index.js')
    const { findPendingChallenge, openChallenge } = await import('./sms-challenge.js')

    const phones: string[] = []

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        if (phones.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.phone, phones))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    const start = async (phone: string) => {
        const pending = await findPendingChallenge(phone, 'register_phone')
        if (Result.isError(pending)) return pending
        return await openChallenge({ phone, flow: 'register_phone', metadata: {} })
    }

    it('one start opens a challenge, the other answers the resend cooldown', async () => {
        const phone = `+1558${String(Date.now() % 10_000_000).padStart(7, '0')}`
        phones.push(phone)
        bothReadBeforeEitherWrites(smsAuthChallengeRepository, 'findLatestPendingForPhoneFlow')

        const results = await Promise.all([start(phone), start(phone)])

        expect(results.filter((result) => Result.isOk(result))).toHaveLength(1)
        const refused = results.find((result) => Result.isError(result))
        expect(refused !== undefined && Result.isError(refused) && refused.error).toMatchObject({
            reason: 'resend_cooldown_active',
        })
        const live = await db
            .select()
            .from(smsAuthChallenges)
            .where(
                and(
                    eq(smsAuthChallenges.phone, phone),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
        expect(live).toHaveLength(1)
    })
})
