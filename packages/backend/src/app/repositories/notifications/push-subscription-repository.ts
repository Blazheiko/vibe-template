import { db } from '#database/db.js'
import { pushNotificationLogs, pushSubscriptions } from '#database/schema.js'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

import { pushNotificationLogRepository } from './push-notification-log-repository.js'

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
        | 'notificationTypes'
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
    create(data: PushSubscriptionInsert): Promise<PushSubscriptionRow>
    findById(id: bigint): Promise<PushSubscriptionRow | undefined>
    findByIdAndUserId(id: bigint, userId: bigint): Promise<PushSubscriptionRow | undefined>
    findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | undefined>
    findByUserId(userId: bigint): Promise<PushSubscriptionRow[]>
    findByUserIdWithLogs(userId: bigint): Promise<PushSubscriptionWithLogs[]>
    update(
        id: bigint,
        userId: bigint,
        data: PushSubscriptionUpdate,
    ): Promise<PushSubscriptionRow | undefined>
    updateByEndpoint(
        endpoint: string,
        userId: bigint,
        data: PushSubscriptionUpdate,
    ): Promise<PushSubscriptionRow | undefined>
    deactivate(id: bigint, userId: bigint): Promise<PushSubscriptionRow | undefined>
    touchLastUsed(ids: bigint[], userId: bigint): Promise<void>
    delete(id: bigint, userId: bigint): Promise<boolean>
    getLogsBySubscriptionId(
        subscriptionId: bigint,
        userId: bigint,
        limit?: number,
    ): Promise<PushNotificationLogRow[]>
}

export const pushSubscriptionRepository: IPushSubscriptionRepository = {
    async create(data) {
        const now = new Date()
        const [created] = await db
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

    async findByIdAndUserId(id, userId) {
        return await db
            .select()
            .from(pushSubscriptions)
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByEndpoint(endpoint) {
        return await db
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

    async findByUserIdWithLogs(userId) {
        const subscriptionsData = await pushSubscriptionRepository.findByUserId(userId)
        if (subscriptionsData.length === 0) return []

        const logs = await pushNotificationLogRepository.latestBySubscriptionIds(
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
    async update(id, userId, data) {
        const [row] = await db
            .update(pushSubscriptions)
            .set({ ...data, updatedAt: new Date(), lastUsedAt: new Date() })
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return row
    },

    // No owner filter on purpose: the endpoint is unique across users, and moving it to
    // another account (same device, account switch) is allowed after the service has
    // checked the browser's keys.
    async updateByEndpoint(endpoint, userId, data) {
        await db
            .update(pushSubscriptions)
            .set({ ...data, userId, updatedAt: new Date(), lastUsedAt: new Date() })
            .where(eq(pushSubscriptions.endpoint, endpoint))
        return pushSubscriptionRepository.findByEndpoint(endpoint)
    },

    async touchLastUsed(ids, userId) {
        if (ids.length === 0) return
        const now = new Date()
        await db
            .update(pushSubscriptions)
            .set({ updatedAt: now, lastUsedAt: now })
            .where(and(inArray(pushSubscriptions.id, ids), eq(pushSubscriptions.userId, userId)))
    },

    async deactivate(id, userId) {
        const [row] = await db
            .update(pushSubscriptions)
            .set({ isActive: false, updatedAt: new Date() })
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return row
    },

    async delete(id, userId) {
        const deleted = await db
            .delete(pushSubscriptions)
            .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
            .returning()
        return deleted.length > 0
    },

    async getLogsBySubscriptionId(subscriptionId, userId, limit = 50) {
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
