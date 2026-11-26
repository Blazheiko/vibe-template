import { userRepository } from '#app/repositories/index.js'
import { asCursor } from '#app/domain/wire.js'
import { toIsoDateTime, type EntityId, type IsoDateTime, type Cursor } from 'shared/brand'
import { toEntityId } from '#app/domain/ids.js'
import type { AdminUserListFilters } from '#app/repositories/index.js'
import { MAX_PAGE_LIMIT } from 'shared/schemas'
import type { Role } from 'shared/access'

export interface AdminUserListItem {
    id: EntityId
    name: string
    email: string
    registeredAt: IsoDateTime
    role: Role
    emailVerified: boolean
}

export interface AdminUserListPage {
    items: AdminUserListItem[]
    total: number
    nextCursor: Cursor | null
    hasMore: boolean
}

export const adminUserService = {
    /**
     * One page of users, newest first. One row more than the page is read to see whether a
     * next page exists; `nextCursor` is the id of the last user of this page (feat-155).
     */
    async listUsers(filters: AdminUserListFilters): Promise<AdminUserListPage> {
        const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_PAGE_LIMIT)
        const result = await userRepository.listAdminUsers({ ...filters, limit: limit + 1 })
        const hasMore = result.items.length > limit
        const pageRows = hasMore ? result.items.slice(0, limit) : result.items
        const lastRow = pageRows.at(-1)
        return {
            items: pageRows.map((user) => ({
                id: toEntityId(user.id),
                name: user.name,
                email: user.email ?? '',
                registeredAt: toIsoDateTime(user.createdAt),
                role: user.role,
                emailVerified: user.emailVerifiedAt !== null,
            })),
            total: result.total,
            nextCursor: hasMore && lastRow !== undefined ? asCursor(String(lastRow.id)) : null,
            hasMore,
        }
    },
}
