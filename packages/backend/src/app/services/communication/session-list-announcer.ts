import logger from '#vendor/utils/logger.js'
import { userEventBus } from '#app/services/communication/user-event-bus.js'

/**
 * feat-233 (Р12): tells every connection of the user, on every instance, that its session list
 * changed. No data: the client reads the first page again. Best effort like the bus itself; the
 * client also reads the list again on every `ws_ready`.
 */
export const announceSessionListChanged = (userId: string): void => {
    userEventBus.publishToUser(userId, 'user_sessions_changed', {}).catch((err: unknown) => {
        logger.warn({ err, userId }, 'user_sessions_changed not published')
    })
}
