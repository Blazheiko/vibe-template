import { Result } from 'better-result'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-199 (security review 2026-11-12, M-2) against a real PostgreSQL: a link is removed only
// for its own account, and two removals at once never take the last way in. The throttle
// (Redis) and the notices are not under test here.
const silent = vi.hoisted(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
}))
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))

describe.skipIf(!hasPg)('sign-in methods on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { hashPassword } = await import('metautil')
    const { oauthAccountRepository } = await import('#app/repositories/index.js')
    const { signInMethodsService } = await import('#app/services/auth/sign-in-methods-service.js')

    const PASSWORD = 'pg-test-password-1'
    const created: bigint[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    const insertUser = async (withPassword: boolean) => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'sign-in-methods',
                email: `${crypto.randomUUID()}@example.test`,
                password: withPassword ? await hashPassword(PASSWORD) : null,
            })
            .returning()
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        return user
    }

    const linkTo = (userId: bigint, provider: string) =>
        oauthAccountRepository.create({
            userId,
            provider,
            providerUserId: `${provider}-${crypto.randomUUID()}`,
            providerEmail: 'someone@example.test',
            providerName: 'Jane',
            providerAvatar: null,
        })

    const request = (
        user: { sessionToken: string },
        linkId: bigint,
        over: Record<string, unknown> = {},
    ) => ({
        linkId,
        currentPassword: undefined as string | undefined,
        presentedSessionToken: user.sessionToken,
        sessionCreatedAt: new Date().toISOString(),
        sessionStored: () => Promise.resolve(true),
        ...over,
    })

    const providersOf = async (userId: bigint): Promise<string[]> =>
        (await oauthAccountRepository.findByUserId(userId)).map((link) => link.provider).sort()

    it('lists only the links of the account that asks', async () => {
        const owner = await insertUser(true)
        const other = await insertUser(true)
        const mine = await linkTo(owner.id, 'github')
        await linkTo(other.id, 'google')

        const result = await signInMethodsService.list(owner.id)

        expect(Result.isOk(result) && result.value).toEqual({
            hasPassword: true,
            methods: [
                {
                    id: String(mine.id),
                    provider: 'github',
                    name: 'Jane',
                    linkedAt: mine.createdAt.toISOString(),
                },
            ],
        })
    })

    it("does not remove another account's link, even with the right password", async () => {
        const attacker = await insertUser(true)
        const victim = await insertUser(true)
        await linkTo(attacker.id, 'github')
        const victimsLink = await linkTo(victim.id, 'google')

        const result = await signInMethodsService.unlink(
            attacker.id,
            request(attacker, victimsLink.id, { currentPassword: PASSWORD }),
        )

        expect(Result.isError(result) && result.error).toMatchObject({ _tag: 'NotFound' })
        expect(await providersOf(victim.id)).toEqual(['google'])
        expect(await providersOf(attacker.id)).toEqual(['github'])
        // The repository refuses it on its own too.
        await db.transaction(async (tx) => {
            expect(
                await oauthAccountRepository.deleteByIdForUser(victimsLink.id, attacker.id, tx),
            ).toBe(false)
        })
        expect(await providersOf(victim.id)).toEqual(['google'])
    })

    it('removes the link with the current password; the provider no longer finds the account', async () => {
        const owner = await insertUser(true)
        const link = await linkTo(owner.id, 'github')
        security.mockClear()

        const refused = await signInMethodsService.unlink(
            owner.id,
            request(owner, link.id, { currentPassword: 'wrong-password-1' }),
        )
        expect(Result.isError(refused) && refused.error).toMatchObject({ _tag: 'BadRequest' })
        expect(await providersOf(owner.id)).toEqual(['github'])

        const result = await signInMethodsService.unlink(
            owner.id,
            request(owner, link.id, { currentPassword: PASSWORD }),
        )

        expect(Result.isOk(result) && result.value).toEqual({ provider: 'github' })
        expect(await providersOf(owner.id)).toEqual([])
        // What an OAuth callback of that identity would look up.
        expect(
            await oauthAccountRepository.findByProviderAndProviderId('github', link.providerUserId),
        ).toBeUndefined()
        expect(security).toHaveBeenCalledWith(owner.id, 'sign_in_method_removed')
    })

    it('an account without a password keeps its last link', async () => {
        const owner = await insertUser(false)
        const link = await linkTo(owner.id, 'github')

        const result = await signInMethodsService.unlink(owner.id, request(owner, link.id))

        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Conflict',
            reason: 'last_sign_in_method',
        })
        expect(await providersOf(owner.id)).toEqual(['github'])
    })

    it('two removals at once never take both links of an account without a password', async () => {
        const owner = await insertUser(false)
        const first = await linkTo(owner.id, 'github')
        const second = await linkTo(owner.id, 'google')

        const outcomes = await Promise.all([
            signInMethodsService.unlink(owner.id, request(owner, first.id)),
            signInMethodsService.unlink(owner.id, request(owner, second.id)),
        ])

        expect(outcomes.filter((outcome) => Result.isOk(outcome))).toHaveLength(1)
        const refused = outcomes.find((outcome) => Result.isError(outcome))
        expect(refused !== undefined && Result.isError(refused) && refused.error).toMatchObject({
            _tag: 'Conflict',
            reason: 'last_sign_in_method',
        })
        expect(await providersOf(owner.id)).toHaveLength(1)
    })
})
