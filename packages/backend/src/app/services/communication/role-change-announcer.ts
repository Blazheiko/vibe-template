import { userEventBus } from '#app/services/communication/user-event-bus.js'

// feat-240 (Р8): after a committed role change, every instance re-reads the role of the user's
// open connections: this one at once, the others through the user event bus (best effort; their
// periodic pass catches up). Never throws.
export const announceRoleChanged = (userId: bigint): void => {
    void userEventBus.notifyServer(String(userId), 'user_role_changed')
}
