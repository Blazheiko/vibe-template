import { eq, sql } from 'drizzle-orm'

import { db } from '#database/db.js'
import { notificationPreferences } from '#database/schema.js'
import type { NotificationPreferenceRow } from 'shared/notifications'

const t = notificationPreferences

// feat-236 (Р4): the channels a user changed. A missing row means the default of the catalog;
// what is locked is decided by the policy in shared/notifications, not here.
export const notificationPreferenceRepository = {
    async findByUserId(userId: bigint): Promise<NotificationPreferenceRow[]> {
        return db
            .select({ category: t.category, channel: t.channel, enabled: t.enabled })
            .from(t)
            .where(eq(t.userId, userId))
    },

    async upsert(
        userId: bigint,
        category: string,
        channel: string,
        enabled: boolean,
    ): Promise<void> {
        await db
            .insert(t)
            .values({ userId, category, channel, enabled })
            .onConflictDoUpdate({
                target: [t.userId, t.category, t.channel],
                set: { enabled, updatedAt: sql`now()` },
            })
    },
}
