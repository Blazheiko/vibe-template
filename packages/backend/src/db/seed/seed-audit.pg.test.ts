import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../test-support/pg-test-db.js'

// feat-247: a key that seals the admin's TOTP secret (derived from APP_KEY outside production).
vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р4, T5.7) on a real PostgreSQL: the seed writes `user.admin.created` for the admin it
// creates in its own transaction; the demo user writes none, and a seed that rolls back leaves
// neither the admin nor its event.
describe.skipIf(!hasPg)('seed audit event on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, users } = await import('#database/schema.js')
    const { createDrizzleSeedStore } = await import('./drizzle-seed-store.js')
    const { runSeed } = await import('./run-seed.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const env = {
        SEED_ADMIN_EMAIL: `seed-admin-${run}@example.test`,
        SEED_ADMIN_PASSWORD: 'admin-password',
        SEED_USER_EMAIL: `seed-user-${run}@example.test`,
        SEED_USER_PASSWORD: 'user-password',
    }
    const extraEmails: string[] = []
    const options = { demo: true, env, hashPassword: (p: string) => Promise.resolve(`h:${p}`) }
    const idOf = async (email: string) => {
        const [row] = await db
            .select({ id: users.id })
            .from(users)
            .where(sql`LOWER(${users.email}) = ${email}`)
        return row?.id
    }

    afterAll(async () => {
        for (const email of [env.SEED_ADMIN_EMAIL, env.SEED_USER_EMAIL, ...extraEmails]) {
            const id = await idOf(email)
            if (id !== undefined) {
                await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
                await db.delete(users).where(eq(users.id, id))
            }
        }
        await pool.end()
    })

    // feat-247 (Р10): the demo admin's TOTP factor, sealed as the TOTP setup seals it.
    it('stores the TOTP factor of the created admin, sealed to its id', async () => {
        const { totpFactors } = await import('#database/schema.js')
        const { mfaSecretBox, totpSecretOwner } =
            await import('#app/services/auth/mfa/mfa-secret-box.js')
        const box = mfaSecretBox()
        if (box === null) throw new Error('no MFA key in the test environment')
        const secret = Buffer.alloc(20, 3)
        const totpEnv = {
            ...env,
            SEED_ADMIN_EMAIL: `seed-totp-admin-${run}@example.test`,
            SEED_USER_EMAIL: `seed-totp-user-${run}@example.test`,
        }
        extraEmails.push(totpEnv.SEED_ADMIN_EMAIL, totpEnv.SEED_USER_EMAIL)
        const report = await db.transaction((tx) =>
            runSeed(createDrizzleSeedStore(tx), {
                ...options,
                env: totpEnv,
                adminTotp: { isProductionLike: false, canSeal: true, generateSecret: () => secret },
            }),
        )

        expect(report.adminTotp).toMatchObject({ status: 'inserted', source: 'generated' })
        const adminId = await idOf(totpEnv.SEED_ADMIN_EMAIL)
        const userId = await idOf(totpEnv.SEED_USER_EMAIL)
        if (adminId === undefined || userId === undefined) throw new Error('not seeded')
        const [factor] = await db.select().from(totpFactors).where(eq(totpFactors.userId, adminId))
        if (factor === undefined) throw new Error('no factor')
        expect(factor.confirmedAt).toBeInstanceOf(Date)
        expect(
            box.open(
                { ciphertext: factor.secretCiphertext, keyId: factor.keyId },
                totpSecretOwner(adminId),
            ),
        ).toEqual(secret)
        expect(await db.select().from(totpFactors).where(eq(totpFactors.userId, userId))).toEqual(
            [],
        )
    })

    const adminEvents = async () => {
        const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(auditEvents)
            .where(eq(auditEvents.action, 'user.admin.created'))
        return row?.count ?? 0
    }

    it('a seed that rolls back leaves no admin and no event', async () => {
        const before = await adminEvents()
        await expect(
            db.transaction(async (tx) => {
                await runSeed(createDrizzleSeedStore(tx), options)
                throw new Error('rolled back')
            }),
        ).rejects.toThrow('rolled back')

        expect(await idOf(env.SEED_ADMIN_EMAIL)).toBeUndefined()
        expect(await adminEvents()).toBe(before)
    })

    it('writes one user.admin.created by the system for the created admin only', async () => {
        const report = await db.transaction((tx) => runSeed(createDrizzleSeedStore(tx), options))

        const adminId = await idOf(env.SEED_ADMIN_EMAIL)
        const userId = await idOf(env.SEED_USER_EMAIL)
        if (adminId === undefined || userId === undefined) throw new Error('not seeded')
        expect(report.auditEvents).toEqual([
            { action: 'user.admin.created', targetType: 'user', targetId: String(adminId) },
        ])
        const events = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.targetUserId, adminId))
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            action: 'user.admin.created',
            actorKind: 'system',
            actorUserId: null,
            actorRole: null,
            requestId: null,
            changes: { role: { from: null, to: 'admin' } },
            metadata: { source: 'seed' },
        })
        expect(
            await db.select().from(auditEvents).where(eq(auditEvents.targetUserId, userId)),
        ).toEqual([])

        // A second run finds the admin and writes nothing.
        const again = await db.transaction((tx) => runSeed(createDrizzleSeedStore(tx), options))
        expect(again.auditEvents).toEqual([])
    })
})
