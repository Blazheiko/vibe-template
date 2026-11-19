import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-232 T4-T5: the user_preferences table (CHECK constraints, cascade) and the upsert of
// userPreferencesRepository.applyPatch, on a real PostgreSQL.

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
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))

describe.skipIf(!hasPg)('user_preferences on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const schema = await import('#database/schema.js')
    const { userPreferencesRepository, withTransaction } =
        await import('#app/repositories/index.js')

    let userId = 0n

    const createUser = async (): Promise<bigint> => {
        const [user] = await db
            .insert(schema.users)
            .values({ name: 'prefs', email: `prefs-${randomUUID()}@x.test` })
            .returning({ id: schema.users.id })
        return user!.id
    }

    const apply = (patch: Parameters<typeof userPreferencesRepository.applyPatch>[1]) =>
        withTransaction((tx) => userPreferencesRepository.applyPatch(userId, patch, tx))

    const rawInsert = (values: string) =>
        db.execute(
            sql.raw(
                `INSERT INTO user_preferences (user_id, revision, font_size, color_theme, theme)
                 VALUES (${String(userId)}, ${values})`,
            ),
        )

    beforeAll(async () => {
        userId = await createUser()
    })

    beforeEach(async () => {
        await db.delete(schema.userPreferences).where(eq(schema.userPreferences.userId, userId))
    })

    afterAll(async () => {
        await db.delete(schema.users).where(eq(schema.users.id, userId))
        await pool.end()
        await sessionCheckPool.end()
    })

    describe('table', () => {
        it('the migration creates an empty table', async () => {
            const rows = await db.select().from(schema.userPreferences)
            expect(rows.filter((row) => row.userId === userId)).toEqual([])
        })

        it('CHECK refuses a font size of 21, an unknown color, an unknown theme, revision 0', async () => {
            await expect(rawInsert(`1, 21, NULL, NULL`)).rejects.toThrow()
            await expect(rawInsert(`1, 13, NULL, NULL`)).rejects.toThrow()
            await expect(rawInsert(`1, NULL, 'red', NULL`)).rejects.toThrow()
            await expect(rawInsert(`1, NULL, NULL, 'system'`)).rejects.toThrow()
            await expect(rawInsert(`0, NULL, NULL, NULL`)).rejects.toThrow()
            await expect(rawInsert(`1, 20, 'mint', 'dark'`)).resolves.toBeDefined()
        })

        it('revision has no default: an insert without it fails', async () => {
            await expect(
                db.execute(sql`INSERT INTO user_preferences (user_id) VALUES (${userId})`),
            ).rejects.toThrow()
        })

        it('deleting the user deletes the row', async () => {
            const other = await createUser()
            await withTransaction((tx) =>
                userPreferencesRepository.applyPatch(other, { theme: 'dark' }, tx),
            )
            expect(await userPreferencesRepository.findByUserId(other)).toBeDefined()

            await db.delete(schema.users).where(eq(schema.users.id, other))

            expect(await userPreferencesRepository.findByUserId(other)).toBeUndefined()
        })
    })

    describe('applyPatch', () => {
        it('no row: findByUserId is undefined', async () => {
            expect(await userPreferencesRepository.findByUserId(userId)).toBeUndefined()
        })

        it('the first patch inserts revision 1, later ones add one; an empty patch too', async () => {
            expect((await apply({ theme: 'dark' })).revision).toBe(1n)
            expect((await apply({ fontSize: 18 })).revision).toBe(2n)
            expect((await apply({})).revision).toBe(3n)
            const empty = await withTransaction((tx) =>
                userPreferencesRepository.applyPatch(userId, {}, tx),
            )
            expect(empty).toMatchObject({ revision: 4n, theme: 'dark', fontSize: 18 })
        })

        it('an empty first patch creates the row with every preference NULL', async () => {
            expect(await apply({})).toMatchObject({
                revision: 1n,
                locale: null,
                timeZone: null,
                theme: null,
                colorTheme: null,
                fontSize: null,
            })
        })

        it('a partial patch keeps the other fields; null resets only its own', async () => {
            await apply({
                locale: 'uk',
                timeZone: 'Europe/Kiev',
                theme: 'dark',
                colorTheme: 'mint',
                fontSize: 18,
            })
            await apply({ fontSize: 20 })
            expect(await userPreferencesRepository.findByUserId(userId)).toMatchObject({
                locale: 'uk',
                timeZone: 'Europe/Kiev',
                theme: 'dark',
                colorTheme: 'mint',
                fontSize: 20,
            })

            const reset = await apply({ theme: null })
            expect(reset).toMatchObject({
                locale: 'uk',
                timeZone: 'Europe/Kiev',
                theme: null,
                colorTheme: 'mint',
                fontSize: 20,
                revision: 3n,
            })
        })

        it('updated_at moves with every change', async () => {
            const first = await apply({ theme: 'dark' })
            await new Promise((resolve) => setTimeout(resolve, 20))
            const second = await apply({ theme: 'light' })
            expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime())
        })

        /**
         * Two transactions upsert at once: the first holds the row (or the conflicting key) until
         * it commits, the second waits on it and then updates. Both start from no row.
         */
        const race = async (
            first: Parameters<typeof userPreferencesRepository.applyPatch>[1],
            second: Parameters<typeof userPreferencesRepository.applyPatch>[1],
        ) => {
            let releaseFirst: () => void = () => undefined
            const firstHeld = new Promise<void>((resolve) => {
                releaseFirst = resolve
            })
            let firstWrote: () => void = () => undefined
            const firstWroteSignal = new Promise<void>((resolve) => {
                firstWrote = resolve
            })
            const one = withTransaction(async (tx) => {
                await userPreferencesRepository.applyPatch(userId, first, tx)
                firstWrote()
                await firstHeld
            })
            await firstWroteSignal
            const two = withTransaction((tx) =>
                userPreferencesRepository.applyPatch(userId, second, tx),
            )
            // The second upsert is blocked on the first transaction's row.
            await new Promise((resolve) => setTimeout(resolve, 100))
            const [{ count }] = (
                await db.execute<{ count: string }>(
                    sql`SELECT count(*)::text AS count FROM pg_stat_activity
                        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
                )
            ).rows as [{ count: string }]
            releaseFirst()
            await Promise.all([one, two])
            return Number(count)
        }

        it('two concurrent patches of different fields both stay, revision +2', async () => {
            const blocked = await race({ theme: 'dark' }, { fontSize: 19 })

            expect(blocked).toBeGreaterThanOrEqual(1)
            expect(await userPreferencesRepository.findByUserId(userId)).toMatchObject({
                theme: 'dark',
                fontSize: 19,
                revision: 2n,
            })
        })

        it('two concurrent patches of one field: the later commit wins, revision +2', async () => {
            await apply({ colorTheme: 'ocean' })

            await race({ colorTheme: 'mint' }, { colorTheme: 'sunset' })

            expect(await userPreferencesRepository.findByUserId(userId)).toMatchObject({
                colorTheme: 'sunset',
                revision: 3n,
            })
        })
    })
})
