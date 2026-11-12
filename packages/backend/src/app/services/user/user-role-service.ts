import { userRepository } from '#app/repositories/index.js'
import type { UserRow } from '#app/repositories/index.js'

export const userRoleService = {
    // `undefined` when the user no longer exists.
    async findRole(userId: bigint): Promise<UserRow['role'] | undefined> {
        const user = await userRepository.findById(userId)
        return user?.role
    },

    /**
     * The role together with the current users.session_token, from one read; `undefined` when
     * the user no longer exists. For a WebSocket connection being opened: its session may have
     * been revoked since the upgrade was let in (feat-209).
     */
    async findAccess(
        userId: bigint,
    ): Promise<{ role: UserRow['role']; sessionToken: string } | undefined> {
        const user = await userRepository.findById(userId)
        return user === undefined ? undefined : { role: user.role, sessionToken: user.sessionToken }
    },
}
