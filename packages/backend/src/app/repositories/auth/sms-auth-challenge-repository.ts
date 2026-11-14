import { db } from '#database/db.js'
import type { DbExecutor, DbTransaction } from '../transaction.js'
import { smsAuthChallenges } from '#database/schema.js'
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

export type SmsAuthChallengeRow = InferSelectModel<typeof smsAuthChallenges>
export type SmsAuthChallengeInsert = InferInsertModel<typeof smsAuthChallenges>
export type SmsAuthChallengeFlow = SmsAuthChallengeInsert['flow']

export interface SmsAuthChallengeRepository {
    create(data: SmsAuthChallengeInsert, executor?: DbExecutor): Promise<SmsAuthChallengeRow>
    findById(id: string): Promise<SmsAuthChallengeRow | undefined>
    findLatestPendingForPhoneFlow(
        phone: string,
        flow: SmsAuthChallengeFlow,
        executor?: DbExecutor,
    ): Promise<SmsAuthChallengeRow | undefined>
    /** Every challenge of this phone and flow that is still waiting, newest first (feat-204). */
    findPendingForPhoneFlow(
        phone: string,
        flow: SmsAuthChallengeFlow,
        executor?: DbExecutor,
    ): Promise<SmsAuthChallengeRow[]>
    /** Invalidates these challenges where they are still waiting (feat-204). */
    invalidatePendingByIds(ids: readonly string[], executor?: DbExecutor): Promise<number>
    /**
     * feat-134 (L2): a transaction-scoped advisory lock on this phone and flow. Two starts that
     * both passed the cooldown check take it one at a time, and the second sees the first one's
     * challenge.
     */
    lockPhoneFlow(phone: string, flow: SmsAuthChallengeFlow, tx: DbTransaction): Promise<void>
    invalidatePendingForPhoneFlow(
        phone: string,
        flow: SmsAuthChallengeFlow,
        executor?: DbExecutor,
    ): Promise<number>
    markIssued(
        id: string,
        data: Pick<SmsAuthChallengeInsert, 'codeHash' | 'providerRequestId' | 'metadata'>,
    ): Promise<SmsAuthChallengeRow | undefined>
    /**
     * Spends one try of the budget, atomically: the row comes back only if the challenge is
     * still waiting (not confirmed, not invalidated, not expired) and had fewer than
     * `maxAttempts` tries. Every comparison of a code must be preceded by a spent try.
     */
    consumeAttempt(
        id: string,
        maxAttempts: number,
        executor?: DbExecutor,
    ): Promise<SmsAuthChallengeRow | undefined>
    markConfirmed(id: string, executor?: DbExecutor): Promise<SmsAuthChallengeRow | undefined>
    markInvalidated(id: string): Promise<SmsAuthChallengeRow | undefined>
    /** Invalidates a challenge that is not confirmed yet; a confirmed one stays as it is. */
    markInvalidatedIfPending(
        id: string,
        executor?: DbExecutor,
    ): Promise<SmsAuthChallengeRow | undefined>
}

export const smsAuthChallengeRepository: SmsAuthChallengeRepository = {
    async create(data, executor = db) {
        const now = new Date()
        const [created] = await executor
            .insert(smsAuthChallenges)
            .values({
                ...data,
                createdAt: now,
                updatedAt: now,
            })
            .returning()

        if (created === undefined) {
            throw new Error('Failed to create SMS auth challenge')
        }

        return created
    },

    async findById(id) {
        return await db
            .select()
            .from(smsAuthChallenges)
            .where(eq(smsAuthChallenges.id, id))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findLatestPendingForPhoneFlow(phone, flow, executor = db) {
        return await executor
            .select()
            .from(smsAuthChallenges)
            .where(
                and(
                    eq(smsAuthChallenges.phone, phone),
                    eq(smsAuthChallenges.flow, flow),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
            .orderBy(sql`${smsAuthChallenges.createdAt} desc`)
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findPendingForPhoneFlow(phone, flow, executor = db) {
        return await executor
            .select()
            .from(smsAuthChallenges)
            .where(
                and(
                    eq(smsAuthChallenges.phone, phone),
                    eq(smsAuthChallenges.flow, flow),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
            .orderBy(sql`${smsAuthChallenges.createdAt} desc`)
    },

    async invalidatePendingByIds(ids, executor = db) {
        if (ids.length === 0) return 0
        const now = new Date()
        const rows = await executor
            .update(smsAuthChallenges)
            .set({ invalidatedAt: now, updatedAt: now })
            .where(
                and(
                    inArray(smsAuthChallenges.id, [...ids]),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
            .returning({ id: smsAuthChallenges.id })
        return rows.length
    },

    async lockPhoneFlow(phone, flow, tx) {
        await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sms_auth_challenge:${flow}:${phone}`}, 0))`,
        )
    },

    async invalidatePendingForPhoneFlow(phone, flow, executor = db) {
        const now = new Date()
        const rows = await executor
            .update(smsAuthChallenges)
            .set({
                invalidatedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(smsAuthChallenges.phone, phone),
                    eq(smsAuthChallenges.flow, flow),
                    isNull(smsAuthChallenges.invalidatedAt),
                    isNull(smsAuthChallenges.confirmedAt),
                ),
            )
            .returning({ id: smsAuthChallenges.id })

        return rows.length
    },

    async markIssued(id, data) {
        const now = new Date()
        const [updated] = await db
            .update(smsAuthChallenges)
            .set({
                codeHash: data.codeHash,
                providerRequestId: data.providerRequestId,
                metadata: data.metadata,
                updatedAt: now,
            })
            .where(
                and(
                    eq(smsAuthChallenges.id, id),
                    isNull(smsAuthChallenges.confirmedAt),
                    isNull(smsAuthChallenges.invalidatedAt),
                    gt(smsAuthChallenges.expiresAt, now),
                ),
            )
            .returning()

        return updated
    },

    async consumeAttempt(id, maxAttempts, executor = db) {
        const now = new Date()
        const [updated] = await executor
            .update(smsAuthChallenges)
            .set({
                attemptCount: sql`${smsAuthChallenges.attemptCount} + 1`,
                updatedAt: now,
            })
            .where(
                and(
                    eq(smsAuthChallenges.id, id),
                    isNull(smsAuthChallenges.confirmedAt),
                    isNull(smsAuthChallenges.invalidatedAt),
                    gt(smsAuthChallenges.expiresAt, now),
                    lt(smsAuthChallenges.attemptCount, maxAttempts),
                ),
            )
            .returning()

        return updated
    },

    async markConfirmed(id, executor = db) {
        const now = new Date()
        const [updated] = await executor
            .update(smsAuthChallenges)
            .set({
                confirmedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(smsAuthChallenges.id, id),
                    isNull(smsAuthChallenges.confirmedAt),
                    isNull(smsAuthChallenges.invalidatedAt),
                    gt(smsAuthChallenges.expiresAt, now),
                ),
            )
            .returning()

        return updated
    },

    async markInvalidated(id) {
        const now = new Date()
        const [updated] = await db
            .update(smsAuthChallenges)
            .set({
                invalidatedAt: now,
                updatedAt: now,
            })
            .where(eq(smsAuthChallenges.id, id))
            .returning()

        return updated
    },

    async markInvalidatedIfPending(id, executor = db) {
        const now = new Date()
        const [updated] = await executor
            .update(smsAuthChallenges)
            .set({
                invalidatedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(smsAuthChallenges.id, id),
                    isNull(smsAuthChallenges.confirmedAt),
                    isNull(smsAuthChallenges.invalidatedAt),
                ),
            )
            .returning()

        return updated
    },
}
