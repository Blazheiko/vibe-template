import { userRepository } from '#app/repositories/index.js'
import type { UserRow } from '#app/repositories/index.js'
import type { UserId } from '#app/domain/ids.js'

export const userRoleService = {
    // `undefined` when the user no longer exists.
    async findRole(userId: UserId): Promise<UserRow['role'] | undefined> {
        const user = await userRepository.findById(userId)
        return user?.role
    },

    /** The current roles of these users by id, one query; a user that no longer exists is absent. */
    findRoles(userIds: UserId[]): Promise<Map<string, UserRow['role']>> {
        return userRepository.findRolesByIds(userIds)
    },

    /**
     * The role together with the current users.session_token, from one read; `undefined` when
     * the user no longer exists. For a WebSocket connection being opened: its session may have
     * been revoked since the upgrade was let in (feat-209).
     */
    async findAccess(
        userId: UserId,
    ): Promise<{ role: UserRow['role']; sessionToken: string } | undefined> {
        const user = await userRepository.findById(userId)
        return user === undefined ? undefined : { role: user.role, sessionToken: user.sessionToken }
    },
}
