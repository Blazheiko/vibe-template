import { type } from '@arktype/type'
import {
    NOTIFICATION_PARAMS_MAX_BYTES,
    buildNotificationLink,
    isNotificationLink,
    notificationCategoryOf,
    type NotificationKind,
    type NotificationParams,
} from 'shared/notifications'
import { NotificationParamsSchemas } from 'shared/schemas'

import logger from '#vendor/utils/logger.js'
import type * as UserEventBusModule from '#app/services/communication/user-event-bus.js'
import { notificationRepository } from '#app/repositories/index.js'
import { pushNotificationSenderService } from '#app/services/notifications/push-notification-sender-service.js'
import { pushTextOf } from '#app/services/notifications/notification-push-texts.js'
import type { UserId } from '#app/domain/ids.js'

// feat-236 (Р5): a notification is stored first, then the user's connections are told and the
// push goes. Best effort, after the business change has committed: a failure of any step is
// logged and never changes or delays the answer that triggered it. Security mails are not a step
// here: their call sites send them, whatever happens to the notification (Р5).

// The bus is loaded on the first signal: importing it opens Redis clients, which every module
// that sends a notification (auth, sessions, support) would otherwise load at import time.
let busModule: Promise<typeof UserEventBusModule> | undefined
const loadBus = (): Promise<typeof UserEventBusModule> =>
    (busModule ??= import('#app/services/communication/user-event-bus.js'))

/** The page a push opens when its notification is stored (Р7): it marks it read, then goes on. */
export const notificationOpenPath = (id: bigint): string => `/notifications/${String(id)}/open`

/** Kinds whose push is skipped while the user has the app open on this instance (Р5). */
const SKIP_PUSH_IF_ONLINE: ReadonlySet<NotificationKind> = new Set(['support.reply'])

export interface NotificationDelivery {
    /** False: the params or the link failed the checks, nothing was stored or sent. */
    valid: boolean
    /** The id of the stored notification, or null when nothing was stored. */
    id: bigint | null
    signalled: boolean
    pushed: boolean
}

type Checked = { params: Record<string, unknown>; link: string | null } | { error: string }

const check = <K extends NotificationKind>(kind: K, params: NotificationParams<K>): Checked => {
    const parsed: unknown = NotificationParamsSchemas[kind](params)
    if (parsed instanceof type.errors) return { error: `params: ${parsed.summary}` }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > NOTIFICATION_PARAMS_MAX_BYTES) {
        return { error: 'params: too large' }
    }
    const link = buildNotificationLink(kind, params)
    if (link !== null && !isNotificationLink(link)) return { error: 'link: not an app path' }
    return { params: parsed as Record<string, unknown>, link }
}

async function deliver<K extends NotificationKind>(
    userId: UserId,
    kind: K,
    params: NotificationParams<K>,
): Promise<NotificationDelivery> {
    const log = { userId: String(userId), kind }
    const outcome: NotificationDelivery = {
        valid: false,
        id: null,
        signalled: false,
        pushed: false,
    }

    // 1. The checks. A failure is a bug of the call site: nothing is stored or sent.
    let checked: Checked
    try {
        checked = check(kind, params)
    } catch (err: unknown) {
        checked = { error: err instanceof Error ? err.message : String(err) }
    }
    if ('error' in checked) {
        logger.error({ ...log, reason: checked.error }, 'Notification refused by its checks')
        return outcome
    }
    outcome.valid = true
    const category = notificationCategoryOf(kind)

    // 2. The row. Without it the push still goes, with the link of the kind (Р5).
    try {
        outcome.id = await notificationRepository.insert({
            userId,
            category,
            kind,
            params: checked.params,
            link: checked.link,
        })
    } catch (err: unknown) {
        logger.warn({ ...log, err }, 'Notification not stored; the push goes without it')
    }

    // 3. The signal: there is something to read again only when a row was stored.
    if (outcome.id !== null) {
        try {
            const { userEventBus } = await loadBus()
            await userEventBus.publishToUser(String(userId), 'notifications_changed', {})
            outcome.signalled = true
        } catch (err: unknown) {
            logger.warn({ ...log, err }, 'notifications_changed not published')
        }
    }

    // 4. The push, under the user's preferences of the category (Р4).
    try {
        const text = pushTextOf(kind, params)
        await pushNotificationSenderService.sendToUser(
            userId,
            {
                ...text,
                url: outcome.id !== null ? notificationOpenPath(outcome.id) : (checked.link ?? '/'),
                ...(outcome.id !== null ? { data: { notificationId: String(outcome.id) } } : {}),
            },
            { category, ...(SKIP_PUSH_IF_ONLINE.has(kind) ? { skipIfOnline: true } : {}) },
        )
        outcome.pushed = true
    } catch (err: unknown) {
        logger.warn({ ...log, err }, 'Push for a notification failed')
    }

    return outcome
}

export const notificationService = {
    /**
     * Stores and delivers a notification in the background (Р5). Returns at once and never
     * throws, so the code after it (a security mail) runs whatever happens here.
     */
    notify<K extends NotificationKind>(
        userId: UserId,
        kind: K,
        params: NotificationParams<K>,
    ): void {
        try {
            deliver(userId, kind, params).catch((err: unknown) => {
                logger.error({ err, userId: String(userId), kind }, 'Notification delivery failed')
            })
        } catch (err: unknown) {
            logger.error({ err, userId: String(userId), kind }, 'Notification delivery failed')
        }
    },

    /** The same delivery, awaited: for tests and for callers that must know the outcome. */
    deliver,
}
