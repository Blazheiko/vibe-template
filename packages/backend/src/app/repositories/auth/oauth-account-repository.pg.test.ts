import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-064: the provider's access and refresh tokens are not stored. The migrations are
// applied by the global setup, so what the database really looks like is what is checked.
describe.skipIf(!hasPg)('oauth_accounts on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { oauthAccountRepository } = await import('#app/repositories/index.js')

    const created: bigint[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    it('has no token columns after the migrations', async () => {
        const result = await db.execute<{ column_name: string }>(
            sql`SELECT column_name FROM information_schema.columns
                WHERE table_name = 'oauth_accounts' ORDER BY column_name`,
        )
        const columns = result.rows.map((row) => row.column_name)

        expect(columns).not.toContain('access_token')
        expect(columns).not.toContain('refresh_token')
        // Nothing else was lost with them.
        expect(columns).toEqual(
            expect.arrayContaining([
                'id',
                'user_id',
                'provider',
                'provider_user_id',
                'provider_email',
                'provider_name',
                'provider_avatar',
                'created_at',
                'updated_at',
            ]),
        )
    })

    it('links a provider account and finds it again by provider and provider id', async () => {
        const [user] = await db
            .insert(users)
            .values({ name: 'oauth-test', email: `${crypto.randomUUID()}@example.test` })
            .returning({ id: users.id })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)

        const link = await oauthAccountRepository.create({
            userId: user.id,
            provider: 'github',
            providerUserId: `gh-${crypto.randomUUID()}`,
            providerEmail: 'someone@example.test',
            providerName: 'Someone',
            providerAvatar: null,
        })
        const found = await oauthAccountRepository.findByProviderAndProviderId(
            'github',
            link.providerUserId,
        )

        expect(found?.id).toBe(link.id)
        expect(found).not.toHaveProperty('accessToken')
        expect(found).not.toHaveProperty('refreshToken')
        expect(await oauthAccountRepository.findByUserId(user.id)).toHaveLength(1)
    })
})
