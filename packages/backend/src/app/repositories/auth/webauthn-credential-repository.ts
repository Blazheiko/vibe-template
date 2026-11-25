import { and, asc, count, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

import { db } from '#database/db.js'
import { users, webauthnCredentials } from '#database/schema.js'
import type { DbExecutor } from '../transaction.js'
import type { PasskeyId, UserId } from '#app/domain/ids.js'

export type WebAuthnCredentialRow = InferSelectModel<typeof webauthnCredentials>

export interface NewWebAuthnCredential {
    userId: UserId
    credentialId: Buffer
    publicKey: Buffer
    signCount: bigint
    transports: string[] | null
    aaguid: string | null
    deviceType: string
    backedUp: boolean
    name: string
    enrollmentId: string
}

/** The answer of a counter update (Р6). */
export type CounterOutcome = 'advanced' | 'regressed' | 'gone'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р9). The writes that change what an account can
// sign in with (insert, delete) run in the caller's transaction under the user's row lock.
export interface IWebAuthnCredentialRepository {
    listByUserId(userId: UserId, executor?: DbExecutor): Promise<WebAuthnCredentialRow[]>
    countByUserId(userId: UserId, executor?: DbExecutor): Promise<number>
    findByCredentialId(
        credentialId: Buffer,
        executor?: DbExecutor,
    ): Promise<WebAuthnCredentialRow | undefined>
    /** The key a registration with this enrollment created, if it is still the user's. */
    findByEnrollment(
        userId: UserId,
        enrollmentId: string,
        executor?: DbExecutor,
    ): Promise<WebAuthnCredentialRow | undefined>
    insert(credential: NewWebAuthnCredential, tx: DbExecutor): Promise<WebAuthnCredentialRow>
    /** Renames a key of the user; false when it is not the user's (or gone). */
    rename(userId: UserId, id: PasskeyId, name: string, executor?: DbExecutor): Promise<boolean>
    /** Removes a key of the user; false when it is not the user's (or gone). */
    deleteOne(userId: UserId, id: PasskeyId, tx: DbExecutor): Promise<boolean>
    /** Removes every key of the user and the user handle (claimLocked); the number removed. */
    deleteAllOfUser(userId: UserId, tx: DbExecutor): Promise<number>
    /**
     * Records a verified signature (Р6). A counter of 0 on both sides is fine (an authenticator
     * without a counter, a synced passkey); otherwise the stored counter only grows:
     * `sign_count < new`. 'regressed' when the key exists and the counter did not grow.
     */
    recordUse(id: PasskeyId, newCount: bigint, executor?: DbExecutor): Promise<CounterOutcome>
    /** The WebAuthn user.id of the account, made from `candidate` when it has none yet. */
    ensureUserHandle(userId: UserId, candidate: Buffer, tx: DbExecutor): Promise<Buffer>
    userHandleOf(userId: UserId, executor?: DbExecutor): Promise<Buffer | null>
}

export const webauthnCredentialRepository: IWebAuthnCredentialRepository = {
    async listByUserId(userId, executor = db) {
        return executor
            .select()
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.userId, userId))
            .orderBy(asc(webauthnCredentials.createdAt), asc(webauthnCredentials.id))
    },

    async countByUserId(userId, executor = db) {
        const [row] = await executor
            .select({ value: count() })
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.userId, userId))
        return row?.value ?? 0
    },

    async findByCredentialId(credentialId, executor = db) {
        return executor
            .select()
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.credentialId, credentialId))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByEnrollment(userId, enrollmentId, executor = db) {
        return executor
            .select()
            .from(webauthnCredentials)
            .where(
                and(
                    eq(webauthnCredentials.userId, userId),
                    eq(webauthnCredentials.enrollmentId, enrollmentId),
                ),
            )
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async insert(credential, tx) {
        const [created] = await tx
            .insert(webauthnCredentials)
            .values({ ...credential, createdAt: new Date() })
            .returning()
        if (created === undefined) throw new Error('webauthn credential insert returned no row')
        return created
    },

    async rename(userId, id, name, executor = db) {
        const updated = await executor
            .update(webauthnCredentials)
            .set({ name })
            .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
            .returning({ id: webauthnCredentials.id })
        return updated.length > 0
    },

    async deleteOne(userId, id, tx) {
        const removed = await tx
            .delete(webauthnCredentials)
            .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
            .returning({ id: webauthnCredentials.id })
        return removed.length > 0
    },

    async deleteAllOfUser(userId, tx) {
        const removed = await tx
            .delete(webauthnCredentials)
            .where(eq(webauthnCredentials.userId, userId))
            .returning({ id: webauthnCredentials.id })
        await tx.update(users).set({ webauthnUserHandle: null }).where(eq(users.id, userId))
        return removed.length
    },

    async recordUse(id, newCount, executor = db) {
        const updated = await executor
            .update(webauthnCredentials)
            .set({ signCount: newCount, lastUsedAt: new Date() })
            .where(
                and(
                    eq(webauthnCredentials.id, id),
                    or(
                        lt(webauthnCredentials.signCount, newCount),
                        and(eq(webauthnCredentials.signCount, 0n), sql`${newCount}::bigint = 0`),
                    ),
                ),
            )
            .returning({ id: webauthnCredentials.id })
        if (updated.length > 0) return 'advanced'
        const exists = await executor
            .select({ id: webauthnCredentials.id })
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.id, id))
            .limit(1)
        return exists.length > 0 ? 'regressed' : 'gone'
    },

    async ensureUserHandle(userId, candidate, tx) {
        await tx
            .update(users)
            .set({ webauthnUserHandle: candidate })
            .where(and(eq(users.id, userId), isNull(users.webauthnUserHandle)))
        const handle = await this.userHandleOf(userId, tx)
        if (handle === null) throw new Error('webauthn user handle missing after ensure')
        return handle
    },

    async userHandleOf(userId, executor = db) {
        const [row] = await executor
            .select({ handle: users.webauthnUserHandle })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return row?.handle ?? null
    },
}
