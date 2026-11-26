import { randomUUID } from 'node:crypto'
import type { NormalizedEmail } from '#app/domain/email.js'
import type { SessionToken } from '#app/domain/secrets.js'
import { uid } from '../../../test-support/ids.js'

import { Result } from 'better-result'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-232 T6: accountService against a real PostgreSQL. The Redis throttle is not under test
// here (account-throttle.redis.test.ts covers it) and always allows.

const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
// The event to the user's connections is not under test here.
vi.mock('#app/services/communication/user-event-bus.js', () => ({
    userEventBus: { publishToUser: () => Promise.resolve() },
}))
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#app/services/auth/enforce-throttle.js', async () => {
    const { Result: R } = await import('better-result')
    return { enforceThrottle: () => Promise.resolve(R.ok(undefined)) }
})

describe.skipIf(!hasPg)('accountService on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const schema = await import('#database/schema.js')
    const { accountService } = await import('./account-service.js')
    const { userPreferencesRepository } = await import('#app/repositories/index.js')

    const stored = () => Promise.resolve(true)
    let userId = uid(0)
    let token = '' as SessionToken

    const nameOf = async (): Promise<string | undefined> =>
        (
            await db
                .select({ name: schema.users.name })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
        ).at(0)?.name

    beforeAll(async () => {
        const [user] = await db
            .insert(schema.users)
            .values({
                name: 'Original',
                email: `account-${randomUUID()}@x.test` as NormalizedEmail,
            })
            .returning({ id: schema.users.id, sessionToken: schema.users.sessionToken })
        userId = user!.id
        token = user!.sessionToken
    })

    beforeEach(async () => {
        await db.delete(schema.userPreferences).where(eq(schema.userPreferences.userId, userId))
        await db.update(schema.users).set({ name: 'Original' }).where(eq(schema.users.id, userId))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await db.delete(schema.users).where(eq(schema.users.id, userId))
        await pool.end()
        await sessionCheckPool.end()
    })

    it('a failing preferences write rolls the name change back', async () => {
        // The schema allows 14-20; past it, the CHECK of the database fails the upsert.
        const body = { name: 'Changed', fontSize: 99 } as never

        await expect(accountService.updateProfile(userId, body, token, stored)).rejects.toThrow()

        expect(await nameOf()).toBe('Original')
        expect(await userPreferencesRepository.findByUserId(userId)).toBeUndefined()
    })

    it('a failing preferences write after an earlier change leaves both as they were', async () => {
        await accountService.updateProfile(userId, { name: 'First', theme: 'dark' }, token, stored)
        vi.spyOn(userPreferencesRepository, 'applyPatch').mockRejectedValueOnce(new Error('boom'))

        await expect(
            accountService.updateProfile(userId, { name: 'Second' }, token, stored),
        ).rejects.toThrow('boom')

        expect(await nameOf()).toBe('First')
        expect(await userPreferencesRepository.findByUserId(userId)).toMatchObject({
            theme: 'dark',
            revision: 1n,
        })
    })

    it('a stored zone the runtime does not know reads as null', async () => {
        await db.insert(schema.userPreferences).values({
            userId,
            timeZone: 'Mars/Base',
            theme: 'light',
            revision: 5n,
        })

        const result = await accountService.getProfile(userId)

        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.preferences).toMatchObject({ timeZone: null, theme: 'light' })
        expect(result.value.revision).toBe('5')
    })

    it('PATCH { timeZone: "UTC" } stores and reads UTC, not null', async () => {
        const saved = await accountService.updateProfile(userId, { timeZone: 'UTC' }, token, stored)
        if (!Result.isOk(saved)) throw new Error('expected ok')
        expect(saved.value.preferences.timeZone).toBe('UTC')

        const read = await accountService.getProfile(userId)
        if (!Result.isOk(read)) throw new Error('expected ok')
        expect(read.value.preferences.timeZone).toBe('UTC')
    })

    it('a name with markup is stored as it is: it is valid and escaped where shown', async () => {
        const markup = '<img src=x onerror=alert(1)>'

        const result = await accountService.updateProfile(userId, { name: markup }, token, stored)

        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.name).toBe(markup)
        expect(await nameOf()).toBe(markup)
    })

    it('revision: "0" without a row, "1" after a name-only change, then +1', async () => {
        const before = await accountService.getProfile(userId)
        if (!Result.isOk(before)) throw new Error('expected ok')
        expect(before.value.revision).toBe('0')

        const first = await accountService.updateProfile(userId, { name: 'A' }, token, stored)
        if (!Result.isOk(first)) throw new Error('expected ok')
        expect(first.value).toMatchObject({ name: 'A', revision: '1' })

        const second = await accountService.updateProfile(userId, { name: 'B' }, token, stored)
        if (!Result.isOk(second)) throw new Error('expected ok')
        expect(second.value.revision).toBe('2')
    })

    // Review 2026-11-19, item 1: every name-only PATCH sets the name to the revision it makes,
    // so a read whose name and revision come from different committed states shows a mismatch.
    it('a read during concurrent changes pairs each name with its own revision', async () => {
        const reads: { name: string; revision: string }[] = []
        let writing = true
        const writer = (async () => {
            for (let i = 1; i <= 40; i += 1) {
                await accountService.updateProfile(
                    userId,
                    { name: `rev-${String(i)}` },
                    token,
                    stored,
                )
            }
            writing = false
        })()
        const readers = Array.from({ length: 3 }, async () => {
            while (writing) {
                const read = await accountService.getProfile(userId)
                if (Result.isOk(read)) reads.push(read.value)
            }
        })
        await Promise.all([writer, ...readers])

        expect(reads.length).toBeGreaterThan(10)
        for (const read of reads) {
            const expected = read.revision === '0' ? 'Original' : `rev-${read.revision}`
            expect(read.name, JSON.stringify(read)).toBe(expected)
        }
    })

    it('a rotated session token: 401 and nothing is written', async () => {
        const result = await accountService.updateProfile(
            userId,
            { name: 'Revoked', theme: 'dark' },
            'not-the-current-token' as SessionToken,
            stored,
        )

        expect(Result.isError(result) && result.error._tag).toBe('Unauthorized')
        expect(await nameOf()).toBe('Original')
        expect(await userPreferencesRepository.findByUserId(userId)).toBeUndefined()
    })
})
