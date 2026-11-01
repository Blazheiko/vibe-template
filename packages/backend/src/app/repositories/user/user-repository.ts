import { db } from '#database/db.js'
import { sessionCheckDb } from '#database/session-check-db.js'
import type { DbExecutor } from '../transaction.js'
import { users } from '#database/schema.js'
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'

export type UserRow = InferSelectModel<typeof users>
export type UserInsert = InferInsertModel<typeof users>
export type UserUpdate = Partial<
    Pick<
        UserInsert,
        'name' | 'email' | 'password' | 'phone' | 'avatar' | 'sessionToken' | 'emailVerifiedAt'
    >
>

export interface AdminUserListFilters {
    userId?: bigint
    dateFrom?: Date
    dateTo?: Date
    limit?: number
}

export interface AdminUserListRow {
    id: bigint
    name: string
    email: string | null
    createdAt: Date
}

export interface AdminOnlineUserRow {
    id: bigint
    name: string
    email: string | null
}

export interface AdminUserDetailRow {
    id: bigint
    name: string
    email: string | null
    phone: string | null
    role: 'user' | 'admin'
    createdAt: Date
}

export interface IUserRepository {
    create(data: UserInsert): Promise<UserRow>
    findById(id: bigint): Promise<UserRow | undefined>
    findByEmail(email: string): Promise<UserRow | undefined>
    findByPhone(phone: string): Promise<UserRow | undefined>
    listAdminUsers(
        filters?: AdminUserListFilters,
    ): Promise<{ items: AdminUserListRow[]; total: number }>
    findAdminOnlineUsersByIds(ids: bigint[]): Promise<AdminOnlineUserRow[]>
    findAdminUserDetailById(id: bigint): Promise<AdminUserDetailRow | undefined>
    emailExistsForOtherUser(email: string, excludeId: bigint): Promise<boolean>
    phoneExistsForOtherUser(phone: string, excludeId: bigint): Promise<boolean>
    /** Pass the transaction when the update belongs to one (see `withTransaction`). */
    update(id: bigint, data: UserUpdate, executor?: DbExecutor): Promise<UserRow | undefined>
    /** The current sessionToken, or undefined when the user does not exist (ADR 0002). */
    findSessionToken(id: bigint): Promise<string | undefined>
    /**
     * Sets a new password and rotates the sessionToken only if the stored password is
     * still `currentPassword` (null/'' for an account that has none yet). Undefined
     * when another request changed it first: two concurrent changes cannot both win.
     */
    changePasswordIfCurrent(
        id: bigint,
        currentPassword: string | null,
        data: { password: string; sessionToken: string },
    ): Promise<UserRow | undefined>
    delete(id: bigint): Promise<boolean>
}

export const userRepository: IUserRepository = {
    async create(data) {
        const now = new Date()
        const [created] = await db
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

        if (filters.dateFrom !== undefined) {
            conditions.push(gte(users.createdAt, filters.dateFrom))
        }

        if (filters.dateTo !== undefined) {
            const nextDay = new Date(filters.dateTo)
            nextDay.setDate(nextDay.getDate() + 1)
            conditions.push(lt(users.createdAt, nextDay))
        }

        let whereClause: SQL | undefined
        if (conditions.length === 1) {
            whereClause = conditions.at(0)
        } else if (conditions.length > 1) {
            whereClause = and(...conditions)
        }
        const limit = Math.min(Math.max(filters.limit ?? 100, 1), 100)

        const rowsQuery = db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
                createdAt: users.createdAt,
            })
            .from(users)
            .where(whereClause)
            .orderBy(desc(users.createdAt))
            .limit(limit)

        const totalQueryBase = db.select({ total: count() }).from(users)

        const totalQuery = totalQueryBase.where(whereClause)

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

    // On the session-check pool, which cancels a stuck query (ADR 0002).
    async findSessionToken(id) {
        const [row] = await sessionCheckDb
            .select({ sessionToken: users.sessionToken })
            .from(users)
            .where(eq(users.id, id))
            .limit(1)
        return row?.sessionToken
    },

    async changePasswordIfCurrent(id, currentPassword, data) {
        const [row] = await db
            .update(users)
            .set({
                password: data.password,
                sessionToken: data.sessionToken,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(users.id, id),
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
