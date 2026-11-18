import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-223: the auth-token-cleanup job deletes one-time tokens and SMS challenges whose
// expires_at is before a cut-off. Real PostgreSQL. The rows of this file expire around
// 2000-2001 and the cut-off is 2001-01-01, so rows other test files leave behind (expiring
// around now) never qualify and the counts are this file's own.

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

const BEFORE = new Date('2001-01-01T00:00:00Z')
const LONG_EXPIRED = new Date('2000-06-01T00:00:00Z')
/** Expired, but within the retention: after the cut-off. */
const RECENTLY_EXPIRED = new Date('2001-06-01T00:00:00Z')
const VALID = new Date(Date.now() + 60 * 60 * 1000)

describe.skipIf(!hasPg)('auth token cleanup on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const schema = await import('#database/schema.js')
    const { authTokenCleanupService } =
        await import('#app/services/auth/auth-token-cleanup-service.js')

    const tokenTables = [
        schema.emailVerifications,
        schema.emailLinkVerifications,
        schema.passwordResetTokens,
        schema.oauthLinkVerifications,
    ] as const
    const allTables = [...tokenTables, schema.smsAuthChallenges] as const

    let userId = 0n

    const insertToken = async (
        table: (typeof tokenTables)[number],
        expiresAt: Date,
    ): Promise<void> => {
        const base = { userId, tokenHash: randomUUID().replaceAll('-', ''), expiresAt }
        const extra =
            table === schema.oauthLinkVerifications
                ? {
                      provider: 'github',
                      providerUserId: '1',
                      providerEmail: 'cleanup@example.test',
                      targetEmail: 'cleanup@example.test',
                      sessionBindingHash: 'x'.repeat(64),
                  }
                : table === schema.emailLinkVerifications
                  ? { targetEmail: 'cleanup@example.test' }
                  : {}
        await db.insert(table as typeof schema.oauthLinkVerifications).values({
            ...extra,
            ...base,
        } as typeof schema.oauthLinkVerifications.$inferInsert)
    }

    const insertChallenge = async (expiresAt: Date): Promise<void> => {
        await db.insert(schema.smsAuthChallenges).values({
            flow: 'register_phone',
            phone: '+10000000000',
            codeHash: 'x',
            resendAvailableAt: expiresAt,
            expiresAt,
        })
    }

    /** `per` rows of each kind in every table. */
    const seed = async (per: { longExpired: number; recent?: number; valid?: number }) => {
        for (const [expiresAt, n] of [
            [LONG_EXPIRED, per.longExpired],
            [RECENTLY_EXPIRED, per.recent ?? 0],
            [VALID, per.valid ?? 0],
        ] as const) {
            for (let i = 0; i < n; i += 1) {
                for (const table of tokenTables) await insertToken(table, expiresAt)
                await insertChallenge(expiresAt)
            }
        }
    }

    const countWhere = async (
        table: (typeof allTables)[number],
        expiresAt: Date,
    ): Promise<number> => {
        const rows = await db
            .select({ id: table.id })
            .from(table)
            .where(sql`${table.expiresAt} = ${expiresAt.toISOString()}`)
        return rows.length
    }

    const remaining = async (expiresAt: Date): Promise<number[]> =>
        await Promise.all(allTables.map((table) => countWhere(table, expiresAt)))

    beforeAll(async () => {
        const [user] = await db
            .insert(schema.users)
            .values({ name: 'token-cleanup', email: `token-cleanup-${randomUUID()}@x.test` })
            .returning({ id: schema.users.id })
        userId = user!.id
    })

    beforeEach(async () => {
        // Only this file's rows: nothing else expires before 2002.
        for (const table of allTables) {
            await db.delete(table).where(sql`${table.expiresAt} < '2002-01-01'`)
        }
    })

    afterAll(async () => {
        for (const table of allTables) {
            await db.delete(table).where(sql`${table.expiresAt} < '2002-01-01'`)
        }
        await db.delete(schema.users).where(sql`${schema.users.id} = ${userId}`)
        await sessionCheckPool.end()
        await pool.end()
    })

    it('deletes only rows that expired before the cut-off, in every table', async () => {
        await seed({ longExpired: 2, recent: 1, valid: 1 })

        const counts = await authTokenCleanupService.purgeExpired({
            before: BEFORE,
            dryRun: false,
        })

        expect(counts).toEqual({ matched: 10, changed: 10 })
        expect(await remaining(LONG_EXPIRED)).toEqual([0, 0, 0, 0, 0])
        expect(await remaining(RECENTLY_EXPIRED)).toEqual([1, 1, 1, 1, 1])
        expect(await remaining(VALID)).toEqual([1, 1, 1, 1, 1])
    })

    it('works in batches until a batch comes back short', async () => {
        await seed({ longExpired: 5 })
        const checkpoint = vi.fn()

        const counts = await authTokenCleanupService.purgeExpired({
            before: BEFORE,
            dryRun: false,
            checkpoint,
            batchSize: 2,
        })

        expect(counts).toEqual({ matched: 25, changed: 25 })
        // 5 rows in batches of 2: 2, 2, 1 → three queries per table.
        expect(checkpoint).toHaveBeenCalledTimes(15)
        expect(await remaining(LONG_EXPIRED)).toEqual([0, 0, 0, 0, 0])
    })

    it('runs no query after a checkpoint throws', async () => {
        await seed({ longExpired: 5 })
        let calls = 0
        const checkpoint = (): void => {
            calls += 1
            if (calls > 1) throw new Error('stop')
        }

        await expect(
            authTokenCleanupService.purgeExpired({
                before: BEFORE,
                dryRun: false,
                checkpoint,
                batchSize: 2,
            }),
        ).rejects.toThrow('stop')

        // Only the first batch of the first table went.
        expect(await remaining(LONG_EXPIRED)).toEqual([3, 5, 5, 5, 5])
    })

    it('counts the same rows on a dry run and changes nothing', async () => {
        await seed({ longExpired: 3, recent: 1, valid: 1 })

        const dry = await authTokenCleanupService.purgeExpired({ before: BEFORE, dryRun: true })

        expect(dry).toEqual({ matched: 15, changed: 0 })
        expect(await remaining(LONG_EXPIRED)).toEqual([3, 3, 3, 3, 3])

        const real = await authTokenCleanupService.purgeExpired({ before: BEFORE, dryRun: false })
        expect(real.matched).toBe(dry.matched)
    })

    it('deletes every row exactly once when two runs overlap', async () => {
        await seed({ longExpired: 7, recent: 1 })

        const [first, second] = await Promise.all([
            authTokenCleanupService.purgeExpired({ before: BEFORE, dryRun: false, batchSize: 2 }),
            authTokenCleanupService.purgeExpired({ before: BEFORE, dryRun: false, batchSize: 2 }),
        ])

        expect(first.changed + second.changed).toBe(35)
        expect(await remaining(LONG_EXPIRED)).toEqual([0, 0, 0, 0, 0])
        expect(await remaining(RECENTLY_EXPIRED)).toEqual([1, 1, 1, 1, 1])
    })

    // The tables are small here, so the planner is told to avoid a sequential scan: what is
    // checked is that the index exists on expires_at and serves the range.
    it('can use the expires_at index of every table', async () => {
        for (const table of allTables) {
            const plan = await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL enable_seqscan = off`)
                const result = await tx.execute<{ 'QUERY PLAN': string }>(
                    sql`EXPLAIN SELECT count(*) FROM ${table} WHERE ${table.expiresAt} < ${BEFORE.toISOString()}`,
                )
                return result.rows.map((row) => row['QUERY PLAN']).join('\n')
            })
            expect(plan).toMatch(/_expires_at_idx/)
        }
    })
})
