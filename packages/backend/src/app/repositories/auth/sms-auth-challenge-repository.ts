import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import { smsAuthChallenges } from '#database/schema.js'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

export type SmsAuthChallengeRow = InferSelectModel<typeof smsAuthChallenges>
export type SmsAuthChallengeInsert = InferInsertModel<typeof smsAuthChallenges>
export type SmsAuthChallengeFlow = SmsAuthChallengeInsert['flow']

export interface SmsAuthChallengeRepository {
    create(data: SmsAuthChallengeInsert): Promise<SmsAuthChallengeRow>
    findById(id: string): Promise<SmsAuthChallengeRow | undefined>
    findLatestPendingForPhoneFlow(
        phone: string,
        flow: SmsAuthChallengeFlow,
    ): Promise<SmsAuthChallengeRow | undefined>
    invalidatePendingForPhoneFlow(
        phone: string,
        flow: SmsAuthChallengeFlow,
        executor?: DbExecutor,
    ): Promise<number>
    markIssued(
        id: string,
        data: Pick<SmsAuthChallengeInsert, 'codeHash' | 'providerRequestId' | 'metadata'>,
    ): Promise<SmsAuthChallengeRow | undefined>
    incrementAttemptCount(id: string): Promise<SmsAuthChallengeRow | undefined>
    markConfirmed(id: string): Promise<SmsAuthChallengeRow | undefined>
    markInvalidated(id: string): Promise<SmsAuthChallengeRow | undefined>
}

export const smsAuthChallengeRepository: SmsAuthChallengeRepository = {
    async create(data) {
        const now = new Date()
        const [created] = await db
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

    async findLatestPendingForPhoneFlow(phone, flow) {
        return await db
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

    async incrementAttemptCount(id) {
        const now = new Date()
        const [updated] = await db
            .update(smsAuthChallenges)
            .set({
                attemptCount: sql`${smsAuthChallenges.attemptCount} + 1`,
                updatedAt: now,
            })
            .where(eq(smsAuthChallenges.id, id))
            .returning()

        return updated
    },

    async markConfirmed(id) {
        const now = new Date()
        const [updated] = await db
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
}
