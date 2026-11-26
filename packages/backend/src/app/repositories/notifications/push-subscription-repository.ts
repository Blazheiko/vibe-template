import { db } from '#database/db.js'
import { pushNotificationLogs, pushSubscriptions } from '#database/schema.js'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'

import { pushNotificationLogRepository } from './push-notification-log-repository.js'
import type { PushSubscriptionId, UserId } from '#app/domain/ids.js'

const LOGS_PER_SUBSCRIPTION = 5

export type PushSubscriptionRow = InferSelectModel<typeof pushSubscriptions>
export type PushSubscriptionInsert = InferInsertModel<typeof pushSubscriptions>
export type PushNotificationLogRow = InferSelectModel<typeof pushNotificationLogs>

export type PushSubscriptionUpdate = Partial<
    Pick<
        PushSubscriptionInsert,
        | 'p256dhKey'
        | 'authKey'
        | 'userAgent'
        | 'ipAddress'
        | 'deviceType'
        | 'browserName'
        | 'browserVersion'
        | 'osName'
        | 'osVersion'
        | 'timezone'
        | 'isActive'
    >
>

export type PushSubscriptionLogSummary = Pick<
    PushNotificationLogRow,
    'id' | 'messageTitle' | 'status' | 'sentAt'
>

export type PushSubscriptionWithLogs = PushSubscriptionRow & {
    notificationLogs: PushSubscriptionLogSummary[]
}

export interface IPushSubscriptionRepository {
    create(data: PushSubscriptionInsert, executor?: DbExecutor): Promise<PushSubscriptionRow>
    findById(id: PushSubscriptionId): Promise<PushSubscriptionRow | undefined>
    findForUser(userId: UserId, id: PushSubscriptionId): Promise<PushSubscriptionRow | undefined>
    findByEndpoint(
        endpoint: string,
        executor?: DbExecutor,
    ): Promise<PushSubscriptionRow | undefined>
    findByUserId(userId: UserId): Promise<PushSubscriptionRow[]>
    /** How many subscriptions the user has, active or not. */
    countByUserId(userId: UserId, executor?: DbExecutor): Promise<number>
    findByUserIdWithLogs(userId: UserId): Promise<PushSubscriptionWithLogs[]>
    update(
        userId: UserId,
        id: PushSubscriptionId,
        data: PushSubscriptionUpdate,
        executor?: DbExecutor,
    ): Promise<PushSubscriptionRow | undefined>
    updateByEndpoint(
        userId: UserId,
        endpoint: string,
        data: PushSubscriptionUpdate,
        executor?: DbExecutor,
    ): Promise<PushSubscriptionRow | undefined>
    deactivate(userId: UserId, id: PushSubscriptionId): Promise<PushSubscriptionRow | undefined>
    touchLastUsed(userId: UserId, ids: PushSubscriptionId[]): Promise<void>
    delete(userId: UserId, id: PushSubscriptionId): Promise<boolean>
    /** Removes every subscription of the user: the devices of a claimed account (feat-097). */
    deleteByUserId(userId: UserId, executor: DbExecutor): Promise<number>
    getLogsBySubscriptionId(
        userId: UserId,
        subscriptionId: PushSubscriptionId,
        limit?: number,
    ): Promise<PushNotificationLogRow[]>
}

export const pushSubscriptionRepository: IPushSubscriptionRepository = {
    async create(data, executor = db) {
        const now = new Date()
        const [created] = await executor
            .insert(pushSubscriptions)
            .values({
                ...data,
                createdAt: data.createdAt ?? now,
                updatedAt: data.updatedAt ?? now,
            })
            .returning()
        if (created === undefined) {
            throw new Error('Failed to create push subscription')
        }
        return created
    },

    async findById(id) {
        return await db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.id, id))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findForUser(userId, id) {
        return await db
            .select()
            .from(pushSubscriptions)
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByEndpoint(endpoint, executor = db) {
        return await executor
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, endpoint))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByUserId(userId) {
        return await db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .orderBy(desc(pushSubscriptions.createdAt))
    },

    async countByUserId(userId, executor = db) {
        const [row] = await executor
            .select({ total: count() })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
        return row?.total ?? 0
    },

    async findByUserIdWithLogs(userId) {
        const subscriptionsData = await pushSubscriptionRepository.findByUserId(userId)
        if (subscriptionsData.length === 0) return []

        const logs = await pushNotificationLogRepository.latestBySubscriptionIds(
            userId,
            subscriptionsData.map((sub) => sub.id),
            LOGS_PER_SUBSCRIPTION,
        )
        const logsBySubscription = new Map<bigint, PushSubscriptionLogSummary[]>()
        for (const { subscriptionId, ...log } of logs) {
            if (subscriptionId === null) continue
            const list = logsBySubscription.get(subscriptionId) ?? []
            list.push(log)
            logsBySubscription.set(subscriptionId, list)
        }
        return subscriptionsData.map((sub) => ({
            ...sub,
            notificationLogs: logsBySubscription.get(sub.id) ?? [],
        }))
    },

    // The row comes from the owner-scoped UPDATE itself: re-reading it by id alone
    // would hand back another user's subscription when the WHERE matched nothing.
    async update(userId, id, data, executor = db) {
        const [row] = await executor
            .update(pushSubscriptions)
            .set({ ...data, updatedAt: new Date(), lastUsedAt: new Date() })
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return row
    },

    // No owner filter on purpose: the endpoint is unique across users, and moving it to
    // another account (same device, account switch) is allowed after the service has
    // checked the browser's keys.
    async updateByEndpoint(userId, endpoint, data, executor = db) {
        const [row] = await executor
            .update(pushSubscriptions)
            .set({ ...data, userId, updatedAt: new Date(), lastUsedAt: new Date() })
            .where(eq(pushSubscriptions.endpoint, endpoint))
            .returning()
        return row
    },

    async touchLastUsed(userId, ids) {
        if (ids.length === 0) return
        const now = new Date()
        await db
            .update(pushSubscriptions)
            .set({ updatedAt: now, lastUsedAt: now })
            .where(and(inArray(pushSubscriptions.id, ids), eq(pushSubscriptions.userId, userId)))
    },

    async deactivate(userId, id) {
        const [row] = await db
            .update(pushSubscriptions)
            .set({ isActive: false, updatedAt: new Date() })
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return row
    },

    async delete(userId, id) {
        const deleted = await db
            .delete(pushSubscriptions)
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return deleted.length > 0
    },

    async deleteByUserId(userId, executor) {
        const deleted = await executor
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .returning({ id: pushSubscriptions.id })
        return deleted.length
    },

    async getLogsBySubscriptionId(userId, subscriptionId, limit = 50) {
        return await db
            .select()
            .from(pushNotificationLogs)
            .where(
                and(
                    eq(pushNotificationLogs.subscriptionId, subscriptionId),
                    eq(pushNotificationLogs.userId, userId),
                ),
            )
            .orderBy(desc(pushNotificationLogs.sentAt))
            .limit(limit)
    },
}
