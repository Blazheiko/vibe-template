import { hashPassword, validatePassword } from 'metautil'
import { describe, expect, it, vi } from 'vitest'

import supportConfig from '../../config/support.js'
import { llmPromptTypeEnum } from '../../database/schema.js'
import { SEED_PROMPTS } from './prompts.js'
import { base32Encode } from '#app/services/auth/mfa/totp.js'
import { runSeed } from './run-seed.js'
import { seedCommitted } from './seed-transaction.js'
import type { ExistingUser, SeedStore, SeedUser } from './run-seed.js'

type FakeStore = SeedStore & {
    prompts: Set<string>
    users: Map<string, ExistingUser>
    insertedUsers: SeedUser[]
}

function createFakeStore(existingUsers: Record<string, ExistingUser> = {}): FakeStore {
    const prompts = new Set<string>()
    const users = new Map(Object.entries(existingUsers))
    const insertedUsers: SeedUser[] = []
    return {
        prompts,
        users,
        insertedUsers,
        insertPromptIfMissing(prompt) {
            if (prompts.has(prompt.type)) return Promise.resolve(false)
            prompts.add(prompt.type)
            return Promise.resolve(true)
        },
        findUserByEmail(email) {
            return Promise.resolve(users.get(email))
        },
        insertUser(user) {
            insertedUsers.push(user)
            const id = BigInt(users.size + 1)
            users.set(user.email, { id, role: user.role })
            // feat-235: the Drizzle store writes the event of an admin in the same transaction.
            return Promise.resolve(
                user.role === 'admin'
                    ? [{ action: 'user.admin.created', targetType: 'user', targetId: String(id) }]
                    : [],
            )
        },
    }
}

const fakeHash = (password: string): Promise<string> => Promise.resolve(`hashed:${password}`)

const demoEnv = {
    SEED_ADMIN_EMAIL: '  Admin@Example.test ',
    SEED_ADMIN_PASSWORD: 'admin-password',
    SEED_USER_EMAIL: 'user@example.test',
    SEED_USER_PASSWORD: 'user-password',
}

describe('SEED_PROMPTS', () => {
    it('covers every llm_prompt_type exactly once', () => {
        expect(SEED_PROMPTS.map((p) => p.type).sort()).toEqual(
            [...llmPromptTypeEnum.enumValues].sort(),
        )
    })

    it('uses the runtime fallback texts and generation settings', () => {
        const byType = Object.fromEntries(SEED_PROMPTS.map((p) => [p.type, p]))
        expect(byType['SUPPORT_SYSTEM']?.content).toBe(supportConfig.defaultSystemPrompt)
        expect(byType['SUPPORT_SYSTEM']?.content).toContain('{context}')
        expect(byType['SUPPORT_FIRST_CHAT']?.content).toBe(supportConfig.defaultFirstChatPrompt)
        expect(byType['SUPPORT_QUERY_TRANSLATION']?.content).toBe(
            supportConfig.defaultTranslationPrompt,
        )
        for (const prompt of SEED_PROMPTS) {
            expect(prompt.temperature).toBe(
                supportConfig.defaultGeneration[prompt.type].temperature,
            )
            expect(prompt.maxTokens).toBe(supportConfig.defaultGeneration[prompt.type].maxTokens)
            expect(prompt.model).toBeNull()
        }
    })
})

describe('runSeed', () => {
    it('inserts prompts and skips demo accounts without --demo, whatever APP_ENV says', async () => {
        const store = createFakeStore()
        const report = await runSeed(store, {
            demo: false,
            env: { ...demoEnv, APP_ENV: 'local' },
            hashPassword: fakeHash,
        })

        expect(Object.values(report.prompts)).toEqual(
            SEED_PROMPTS.map(() => ({ status: 'inserted' })),
        )
        expect(report.admin).toEqual({
            status: 'skipped',
            reason: 'demo_disabled',
        })
        expect(report.user).toEqual({ status: 'skipped', reason: 'demo_disabled' })
        expect(store.insertedUsers).toEqual([])
    })

    it('is idempotent: a second run only skips', async () => {
        const store = createFakeStore()
        const options = { demo: true, env: demoEnv, hashPassword: fakeHash }
        await runSeed(store, options)
        const second = await runSeed(store, options)

        expect(Object.values(second.prompts)).toEqual(
            SEED_PROMPTS.map(() => ({ status: 'skipped', reason: 'already_exists' })),
        )
        expect(second.admin).toEqual({
            status: 'skipped',
            reason: 'already_exists',
        })
        expect(second.user).toEqual({
            status: 'skipped',
            reason: 'already_exists',
        })
        expect(store.insertedUsers).toHaveLength(2)
    })

    it('creates the admin and the user with normalized emails and hashed passwords', async () => {
        const store = createFakeStore()
        const report = await runSeed(store, {
            demo: true,
            env: demoEnv,
            hashPassword: fakeHash,
        })

        expect(report.admin).toEqual({ status: 'inserted' })
        expect(report.user).toEqual({ status: 'inserted' })
        expect(store.insertedUsers).toEqual([
            {
                name: 'Admin',
                email: 'admin@example.test',
                passwordHash: 'hashed:admin-password',
                role: 'admin',
            },
            {
                name: 'Demo User',
                email: 'user@example.test',
                passwordHash: 'hashed:user-password',
                role: 'user',
            },
        ])
    })

    it('stores a hash that validatePassword accepts, never the plain password', async () => {
        const store = createFakeStore()
        await runSeed(store, { demo: true, env: demoEnv, hashPassword })

        const admin = store.insertedUsers[0]
        expect(admin?.passwordHash).not.toBe('admin-password')
        expect(admin?.passwordHash.startsWith('$scrypt$')).toBe(true)
        expect(await validatePassword('admin-password', admin?.passwordHash ?? '')).toBe(true)
    })

    it('reports missing_credentials when SEED_* variables are absent or blank', async () => {
        const store = createFakeStore()
        const report = await runSeed(store, {
            demo: true,
            env: {
                SEED_ADMIN_EMAIL: 'admin@example.test',
                SEED_ADMIN_PASSWORD: '  ',
            },
            hashPassword: fakeHash,
        })

        expect(report.admin).toEqual({
            status: 'skipped',
            reason: 'missing_credentials',
        })
        expect(report.user).toEqual({
            status: 'skipped',
            reason: 'missing_credentials',
        })
        expect(store.insertedUsers).toEqual([])
    })

    it('does not promote an existing non-admin user to admin', async () => {
        const store = createFakeStore({
            'admin@example.test': { id: 7n, role: 'user' },
        })
        const report = await runSeed(store, {
            demo: true,
            env: demoEnv,
            hashPassword: fakeHash,
        })

        expect(report.admin).toEqual({
            status: 'skipped',
            reason: 'exists_without_admin_role',
        })
        expect(store.users.get('admin@example.test')).toEqual({
            id: 7n,
            role: 'user',
        })
        expect(store.insertedUsers.map((u) => u.role)).toEqual(['user'])
    })

    it("propagates store errors so the caller's transaction rolls back", async () => {
        const store = createFakeStore()
        store.insertUser = () => Promise.reject(new Error('insert failed'))

        await expect(
            runSeed(store, { demo: true, env: demoEnv, hashPassword: fakeHash }),
        ).rejects.toThrow('insert failed')
    })

    // feat-235 (Р12): the event of the created admin comes back in the report, to be logged once
    // the seed's transaction committed; an admin that already exists writes none.
    it('reports the user.admin.created event of the created admin only', async () => {
        const store = createFakeStore()
        const options = { demo: true, env: demoEnv, hashPassword: fakeHash }

        const first = await runSeed(store, options)
        expect(first.auditEvents).toEqual([
            { action: 'user.admin.created', targetType: 'user', targetId: '1' },
        ])

        const second = await runSeed(store, options)
        expect(second.admin).toEqual({ status: 'skipped', reason: 'already_exists' })
        expect(second.auditEvents).toEqual([])
    })

    it('an existing non-admin with the admin address writes no event', async () => {
        const store = createFakeStore({ 'admin@example.test': { id: 7n, role: 'user' } })
        const report = await runSeed(store, { demo: true, env: demoEnv, hashPassword: fakeHash })
        expect(report.admin).toEqual({ status: 'skipped', reason: 'exists_without_admin_role' })
        expect(report.auditEvents).toEqual([])
    })
})

// feat-247 (Р10): the demo admin gets a TOTP factor, so it meets MFA_REQUIRED_FOR_STAFF.
describe('runSeed: the TOTP factor of the demo admin', () => {
    const KNOWN = Buffer.alloc(20, 7)
    const GENERATED = Buffer.alloc(20, 9)
    const totpOptions = (isProductionLike: boolean, canSeal = true) => ({
        isProductionLike,
        canSeal,
        generateSecret: () => GENERATED,
    })
    const run = (
        store: FakeStore,
        env: Record<string, string>,
        isProductionLike: boolean,
        canSeal = true,
    ) =>
        runSeed(store, {
            demo: true,
            env,
            hashPassword: fakeHash,
            adminTotp: totpOptions(isProductionLike, canSeal),
        })

    it('development without SEED_ADMIN_TOTP_SECRET: a generated secret, for the admin only', async () => {
        const store = createFakeStore()
        const report = await run(store, demoEnv, false)

        expect(report.adminTotp).toEqual({
            status: 'inserted',
            secret: GENERATED,
            source: 'generated',
        })
        expect(store.insertedUsers[0]?.totpSecret).toEqual(GENERATED)
        expect(store.insertedUsers[1]).not.toHaveProperty('totpSecret')
    })

    it.each([false, true])(
        'SEED_ADMIN_TOTP_SECRET is used as it is (production-like: %s)',
        async (isProductionLike) => {
            const store = createFakeStore()
            const env = {
                ...demoEnv,
                SEED_ADMIN_TOTP_SECRET: ` ${base32Encode(KNOWN).toLowerCase()} `,
            }
            const report = await run(store, env, isProductionLike)

            expect(report.adminTotp).toEqual({ status: 'inserted', secret: KNOWN, source: 'env' })
            expect(store.insertedUsers[0]?.totpSecret).toEqual(KNOWN)
        },
    )

    it('production-like without the secret: no known secret is made, the admin has no factor', async () => {
        const store = createFakeStore()
        const report = await run(store, demoEnv, true)

        expect(report.admin).toEqual({ status: 'inserted' })
        expect(report.adminTotp).toEqual({ status: 'skipped', reason: 'production_like' })
        expect(store.insertedUsers[0]).not.toHaveProperty('totpSecret')
    })

    it('no key to seal the secret with: the admin is created without a factor', async () => {
        const store = createFakeStore()
        const report = await run(store, demoEnv, false, false)

        expect(report.adminTotp).toEqual({ status: 'skipped', reason: 'no_mfa_key' })
        expect(store.insertedUsers[0]).not.toHaveProperty('totpSecret')
    })

    it.each([
        ['not base32', 'not-base32!'],
        ['too short', 'JBSWY3DPEHPK3PXP'],
    ])('a malformed SEED_ADMIN_TOTP_SECRET (%s) fails the seed before writing', async (_n, raw) => {
        const store = createFakeStore()
        await expect(
            run(store, { ...demoEnv, SEED_ADMIN_TOTP_SECRET: raw }, false),
        ).rejects.toThrow('SEED_ADMIN_TOTP_SECRET')
        expect(store.insertedUsers).toEqual([])
    })

    it('an admin that exists, or no --demo: no factor and nothing reported as inserted', async () => {
        const store = createFakeStore()
        await run(store, demoEnv, false)
        const again = await run(store, demoEnv, false)
        expect(again.adminTotp).toEqual({ status: 'skipped', reason: 'admin_not_created' })

        const noDemo = await runSeed(createFakeStore(), {
            demo: false,
            env: { ...demoEnv, SEED_ADMIN_TOTP_SECRET: 'not-base32!' },
            hashPassword: fakeHash,
            adminTotp: totpOptions(false),
        })
        expect(noDemo.adminTotp).toEqual({ status: 'skipped', reason: 'admin_not_created' })
    })

    it('without adminTotp options the admin gets no factor', async () => {
        const store = createFakeStore()
        const report = await runSeed(store, { demo: true, env: demoEnv, hashPassword: fakeHash })
        expect(report.adminTotp).toEqual({ status: 'skipped', reason: 'not_configured' })
        expect(store.insertedUsers[0]).not.toHaveProperty('totpSecret')
    })
})

describe('seedCommitted', () => {
    const report = {
        prompts: {},
        admin: { status: 'inserted' },
        user: { status: 'inserted' },
        auditEvents: [{ action: 'user.admin.created', targetType: 'user', targetId: '1' }],
    } as never

    it('logs the events once the transaction committed', async () => {
        const log = { info: vi.fn() }
        await seedCommitted(
            (work) => work(undefined),
            () => Promise.resolve(report),
            log,
        )
        expect(log.info).toHaveBeenCalledWith(
            { audit: { action: 'user.admin.created', targetType: 'user', targetId: '1' } },
            'audit event',
        )
    })

    it('a transaction that fails logs nothing', async () => {
        const log = { info: vi.fn() }
        await expect(
            seedCommitted(
                async (work) => {
                    await work(undefined)
                    throw new Error('commit failed')
                },
                () => Promise.resolve(report),
                log,
            ),
        ).rejects.toThrow('commit failed')
        expect(log.info).not.toHaveBeenCalled()
    })
})
