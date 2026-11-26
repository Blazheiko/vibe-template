import logger from '../vendor/utils/logger.js'
import { userEventBus } from '../app/services/communication/user-event-bus.js'
import type { UserId } from '#app/domain/ids.js'

/**
 * feat-240 (Р7): the CLI is not an instance (no subscriber, no connections), so it only publishes
 * the server event to the running instances. A failure is a warning: the role is already changed
 * and their periodic pass applies it.
 */
export const publishRoleChangedFromCli = async (userId: UserId): Promise<void> => {
    try {
        await userEventBus.publishRemote(String(userId), 'user_role_changed')
    } catch (err) {
        logger.warn({ err, userId: String(userId) }, 'Role change not signalled to the instances')
        console.warn('The running instances were not signalled; their periodic pass applies it.')
    }
}
