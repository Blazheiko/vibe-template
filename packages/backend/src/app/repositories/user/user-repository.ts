import { db } from '#database/db.js'
import { sessionCheckDb } from '#database/session-check-db.js'
import type { DbExecutor, DbTransaction } from '../transaction.js'
import { users } from '#database/schema.js'
import type { UserId } from '#app/domain/ids.js'
import type { SessionToken } from '#app/domain/secrets.js'
import type { NormalizedEmail } from '#app/domain/email.js'
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'
import { MAX_PAGE_LIMIT } from 'shared/schemas'
import type { Role } from 'shared/access'

export type UserRow = InferSelectModel<typeof users>
export type UserInsert = InferInsertModel<typeof users>
export type UserUpdate = Partial<
    Pick<
        UserInsert,
        'name' | 'email' | 'password' | 'phone' | 'avatar' | 'sessionToken' | 'emailVerifiedAt'
    >
>

export interface AdminUserListFilters {
    userId?: UserId
    /** feat-241: only the users with this role. */
    role?: Role
    dateFrom?: Date
    dateTo?: Date
    /** Only users with an id below this one: the last id of the previous page. */
    cursor?: UserId
    /** Rows to read; the service asks for one more than a page. */
    limit?: number
}

export interface AdminUserListRow {
    id: UserId
    name: string
    email: string | null
    createdAt: Date
    role: Role
    emailVerifiedAt: Date | null
}

export interface AdminOnlineUserRow {
    id: UserId
    name: string
    email: string | null
}

export interface AdminUserDetailRow {
    id: UserId
    name: string
    email: string | null
    phone: string | null
    role: Role
    createdAt: Date
}

export interface IUserRepository {
    create(data: UserInsert, executor?: DbExecutor): Promise<UserRow>
    findById(id: UserId): Promise<UserRow | undefined>
    findByEmail(email: NormalizedEmail): Promise<UserRow | undefined>
    findByPhone(phone: string): Promise<UserRow | undefined>
    listAdminUsers(
        filters?: AdminUserListFilters,
    ): Promise<{ items: AdminUserListRow[]; total: number }>
    findAdminOnlineUsersByIds(ids: UserId[]): Promise<AdminOnlineUserRow[]>
    findAdminUserDetailById(id: UserId): Promise<AdminUserDetailRow | undefined>
    emailExistsForOtherUser(email: NormalizedEmail, excludeId: UserId): Promise<boolean>
    phoneExistsForOtherUser(phone: string, excludeId: UserId): Promise<boolean>
    /** Pass the transaction when the update belongs to one (see `withTransaction`). */
    update(id: UserId, data: UserUpdate, executor?: DbExecutor): Promise<UserRow | undefined>
    /**
     * The user's row locked FOR UPDATE until `tx` ends, or undefined when the user does not
     * exist. Every flow that changes credentials or consumes a one-time token locks the user
     * first, so they run one at a time per user (feat-096).
     */
    lockById(id: UserId, tx: DbExecutor): Promise<UserRow | undefined>
    /**
     * Locks the rows of several users FOR UPDATE, one at a time in ascending id order, so two
     * transactions that lock the same pair (an admin and the account it acts on, two admins
     * acting on each other) wait for each other instead of deadlocking. Users that do not exist
     * are missing from the map.
     */
    lockManyById(ids: readonly UserId[], tx: DbExecutor): Promise<Map<UserId, UserRow>>
    /**
     * feat-240 (Р6): serializes every role change on one transaction-scoped advisory lock, taken
     * first in the transaction; released at commit or rollback.
     */
    lockRoleChanges(tx: DbTransaction): Promise<void>
    countByRole(role: Role, tx: DbExecutor): Promise<number>
    updateRole(id: UserId, role: Role, tx: DbExecutor): Promise<Role | undefined>
    /**
     * Updates the user only while users.session_token is still `expectedSessionToken`, the
     * token the request presented (`Auth.getPresentedUserToken`). Undefined when the user is
     * gone or the token was rotated after the request was let in (feat-096).
     */
    updateIfSessionToken(
        id: UserId,
        expectedSessionToken: SessionToken,
        data: UserUpdate,
        executor?: DbExecutor,
    ): Promise<UserRow | undefined>
    /**
     * feat-232: the profile name, written only while users.session_token is still the one the
     * request presented. Undefined when the user is gone or the session was revoked meanwhile.
     */
    updateNameIfSessionToken(
        id: UserId,
        expectedSessionToken: SessionToken,
        name: string,
        tx: DbExecutor,
    ): Promise<{ name: string } | undefined>
    /**
     * feat-232: the name of the user, read FOR SHARE in `tx` while users.session_token is still
     * the presented one: a revocation (it rotates the token) waits for `tx` to end, so a
     * profile change let in before it commits before it, never after.
     */
    shareIfSessionToken(
        id: UserId,
        expectedSessionToken: SessionToken,
        tx: DbExecutor,
    ): Promise<{ name: string } | undefined>
    /**
     * Sets the avatar key (or null) while users.session_token is still `expectedSessionToken`,
     * and returns the key it replaced, read from the row locked in the same transaction
     * (feat-116): of two concurrent changes each gets the key the other set, so every object
     * replaced is deleted exactly once. Undefined when the user is gone or the token was rotated.
     */
    replaceAvatarIfSessionToken(
        id: UserId,
        expectedSessionToken: SessionToken,
        avatar: string | null,
    ): Promise<{ user: UserRow; previousAvatar: string | null } | undefined>
    /**
     * The current roles of these users by id; a user that no longer exists is absent.
     * Bounded like findSessionToken: it rejects once SESSION_TOKEN_CHECK_TIMEOUT_MS has
     * passed, and the statement is cancelled on the server.
     */
    findRolesByIds(ids: UserId[]): Promise<Map<string, UserRow['role']>>
    /** The names of these users by id (feat-235: the audit log); a deleted user is absent. */
    findNamesByIds(ids: readonly UserId[]): Promise<Map<string, string>>
    /** The current sessionToken, or undefined when the user does not exist (ADR 0002). */
    findSessionToken(id: UserId): Promise<SessionToken | undefined>
    /**
     * The current sessionToken of these users by id; a user that no longer exists is absent.
     * Bounded like findSessionToken.
     */
    findSessionTokensByIds(ids: UserId[]): Promise<Map<string, SessionToken>>
    /**
     * Sets a new password and rotates the sessionToken only if the stored password is
     * still `currentPassword` (null/'' for an account that has none yet) and the
     * sessionToken is still `expectedSessionToken`, the one the request presented.
     * Undefined when another request changed either first: two concurrent changes cannot
     * both win, and a change let in before a revocation cannot outlive it.
     */
    changePasswordIfCurrent(
        id: UserId,
        currentPassword: string | null,
        expectedSessionToken: SessionToken,
        data: { password: string; sessionToken: SessionToken },
        executor?: DbExecutor,
    ): Promise<UserRow | undefined>
    delete(id: UserId): Promise<boolean>
}

export const userRepository: IUserRepository = {
    async create(data, executor = db) {
        const now = new Date()
        const [created] = await executor
            .insert(users)
            .values({
                ...data,
                createdAt: now,
                updatedAt: now,
            })
            .returning()
        if (created === undefined) {
            throw new Error('Failed to create user')
        }
        return created
    },

    async findById(id) {
        return await db
            .select()
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByEmail(email) {
        return await db
            .select()
            .from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${email})`)
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByPhone(phone) {
        return await db
            .select()
            .from(users)
            .where(eq(users.phone, phone))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async listAdminUsers(filters = {}) {
        const conditions: SQL[] = []

        if (filters.userId !== undefined) {
            conditions.push(eq(users.id, filters.userId))
        }

        if (filters.role !== undefined) {
            conditions.push(eq(users.role, filters.role))
        }

        if (filters.dateFrom !== undefined) {
            conditions.push(gte(users.createdAt, filters.dateFrom))
        }

        if (filters.dateTo !== undefined) {
            const nextDay = new Date(filters.dateTo)
            nextDay.setDate(nextDay.getDate() + 1)
            conditions.push(lt(users.createdAt, nextDay))
        }

        // The total counts every match; the cursor only moves the page.
        const totalWhere = conditions.length > 0 ? and(...conditions) : undefined
        if (filters.cursor !== undefined) {
            conditions.push(lt(users.id, filters.cursor))
        }
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined
        const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_PAGE_LIMIT + 1)

        const rowsQuery = db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
                createdAt: users.createdAt,
                role: users.role,
                emailVerifiedAt: users.emailVerifiedAt,
            })
            .from(users)
            .where(whereClause)
            // By id, newest first: the order the cursor pages through (feat-155). The id grows
            // with registration, and unlike created_at it never ties.
            .orderBy(desc(users.id))
            .limit(limit)

        const totalQueryBase = db.select({ total: count() }).from(users)

        const totalQuery = totalQueryBase.where(totalWhere)

        const [rows, totalRows] = await Promise.all([rowsQuery, totalQuery])

        return {
            items: rows,
            total: totalRows.at(0)?.total ?? 0,
        }
    },

    async findAdminOnlineUsersByIds(ids) {
        if (ids.length === 0) return []

        return await db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
            })
            .from(users)
            .where(inArray(users.id, ids))
    },

    async findAdminUserDetailById(id) {
        return await db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
                phone: users.phone,
                role: users.role,
                createdAt: users.createdAt,
            })
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async emailExistsForOtherUser(email, excludeId) {
        const result = await db
            .select({ id: users.id })
            .from(users)
            .where(and(sql`LOWER(${users.email}) = LOWER(${email})`, ne(users.id, excludeId)))
            .limit(1)
        return result.length > 0
    },

    async phoneExistsForOtherUser(phone, excludeId) {
        const result = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.phone, phone), ne(users.id, excludeId)))
            .limit(1)
        return result.length > 0
    },

    async update(id, data, executor = db) {
        const [row] = await executor
            .update(users)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(users.id, id))
            .returning()
        return row
    },

    async lockRoleChanges(tx) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('user_role_change', 0))`)
    },

    async countByRole(role, tx) {
        const [row] = await tx.select({ total: count() }).from(users).where(eq(users.role, role))
        return row?.total ?? 0
    },

    async updateRole(id, role, tx) {
        const [row] = await tx
            .update(users)
            .set({ role, updatedAt: new Date() })
            .where(eq(users.id, id))
            .returning({ role: users.role })
        return row?.role
    },

    async lockById(id, tx) {
        return await tx
            .select()
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
            .for('update')
            .then((rows) => rows.at(0))
    },

    async lockManyById(ids, tx) {
        const locked = new Map<UserId, UserRow>()
        const ordered = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        for (const id of ordered) {
            const row = await userRepository.lockById(id, tx)
            if (row !== undefined) locked.set(id, row)
        }
        return locked
    },

    async updateIfSessionToken(id, expectedSessionToken, data, executor = db) {
        const [row] = await executor
            .update(users)
            .set({ ...data, updatedAt: new Date() })
            .where(and(eq(users.id, id), eq(users.sessionToken, expectedSessionToken)))
            .returning()
        return row
    },

    async updateNameIfSessionToken(id, expectedSessionToken, name, tx) {
        const [row] = await tx
            .update(users)
            .set({ name, updatedAt: new Date() })
            .where(and(eq(users.id, id), eq(users.sessionToken, expectedSessionToken)))
            .returning({ name: users.name })
        return row
    },

    async shareIfSessionToken(id, expectedSessionToken, tx) {
        const [row] = await tx
            .select({ name: users.name })
            .from(users)
            .where(and(eq(users.id, id), eq(users.sessionToken, expectedSessionToken)))
            .limit(1)
            .for('share')
        return row
    },

    async replaceAvatarIfSessionToken(id, expectedSessionToken, avatar) {
        return db.transaction(async (tx) => {
            const [current] = await tx
                .select({ avatar: users.avatar })
                .from(users)
                .where(and(eq(users.id, id), eq(users.sessionToken, expectedSessionToken)))
                .for('update')
            if (current === undefined) return undefined
            const [row] = await tx
                .update(users)
                .set({ avatar, updatedAt: new Date() })
                .where(eq(users.id, id))
                .returning()
            return row === undefined ? undefined : { user: row, previousAvatar: current.avatar }
        })
    },

    // On the session-check pool, which cancels a stuck query: the WS admin re-check runs
    // one pass at a time, so a query that hangs would stop every later pass (feat-062).
    async findRolesByIds(ids) {
        if (ids.length === 0) return new Map()
        const rows = await sessionCheckDb
            .select({ id: users.id, role: users.role })
            .from(users)
            .where(inArray(users.id, ids))
        return new Map(rows.map((row) => [String(row.id), row.role]))
    },

    async findNamesByIds(ids) {
        if (ids.length === 0) return new Map()
        const rows = await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, [...ids]))
        return new Map(rows.map((row) => [String(row.id), row.name]))
    },

    // On the session-check pool, which cancels a stuck query (ADR 0002).
    async findSessionToken(id) {
        const [row] = await sessionCheckDb
            .select({ sessionToken: users.sessionToken })
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
        return row?.sessionToken
    },

    // On the session-check pool: the WS session re-check runs one pass at a time, so a query
    // that hangs would stop every later pass (feat-195).
    async findSessionTokensByIds(ids) {
        if (ids.length === 0) return new Map()
        const rows = await sessionCheckDb
            .select({ id: users.id, sessionToken: users.sessionToken })
            .from(users)
            .where(inArray(users.id, ids))
        return new Map(rows.map((row) => [String(row.id), row.sessionToken]))
    },

    async changePasswordIfCurrent(id, currentPassword, expectedSessionToken, data, executor = db) {
        const [row] = await executor
            .update(users)
            .set({
                password: data.password,
                sessionToken: data.sessionToken,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(users.id, id),
                    eq(users.sessionToken, expectedSessionToken),
                    currentPassword === null || currentPassword === ''
                        ? or(isNull(users.password), eq(users.password, ''))
                        : eq(users.password, currentPassword),
                ),
            )
            .returning()
        return row
    },

    async delete(id) {
        const deleted = await db.delete(users).where(eq(users.id, id)).returning()
        return deleted.length > 0
    },
}
