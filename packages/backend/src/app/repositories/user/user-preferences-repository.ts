import { db } from '#database/db.js'
import { userPreferences } from '#database/schema.js'
import { eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'

export type UserPreferencesRow = InferSelectModel<typeof userPreferences>

/**
 * The preferences a PATCH changes (feat-232, Р2): a key that is absent is left as it is, a key
 * set to `null` writes NULL. An empty patch (a change of the name only) still bumps `revision`.
 */
export type UserPreferencesPatch = Partial<
    Pick<UserPreferencesRow, 'locale' | 'timeZone' | 'theme' | 'colorTheme' | 'fontSize'>
>

const PATCH_KEYS = ['locale', 'timeZone', 'theme', 'colorTheme', 'fontSize'] as const

/** Only the keys present in `patch`; an `undefined` value counts as absent. */
const presentFields = (patch: UserPreferencesPatch): UserPreferencesPatch => {
    const fields: Record<string, unknown> = {}
    for (const key of PATCH_KEYS) {
        if (patch[key] !== undefined) fields[key] = patch[key]
    }
    return fields
}

export interface IUserPreferencesRepository {
    findByUserId(userId: bigint, executor?: DbExecutor): Promise<UserPreferencesRow | undefined>
    /**
     * One upsert (Р12): the first change inserts the row with `revision = 1` and the passed
     * fields; a later one updates only the passed fields and adds one to `revision`. The row
     * lock of the conflicting UPDATE orders concurrent changes: changes of different fields
     * both stay, of the same field the later commit wins, and each adds one.
     */
    applyPatch(
        userId: bigint,
        patch: UserPreferencesPatch,
        tx: DbExecutor,
    ): Promise<UserPreferencesRow>
}

export const userPreferencesRepository: IUserPreferencesRepository = {
    async findByUserId(userId, executor = db) {
        const [row] = await executor
            .select()
            .from(userPreferences)
            .where(eq(userPreferences.userId, userId))
            .limit(1)
        return row
    },

    async applyPatch(userId, patch, tx) {
        const fields = presentFields(patch)
        const [row] = await tx
            .insert(userPreferences)
            .values({ ...fields, userId, revision: 1n })
            .onConflictDoUpdate({
                target: userPreferences.userId,
                set: {
                    ...fields,
                    revision: sql`${userPreferences.revision} + 1`,
                    updatedAt: sql`now()`,
                },
            })
            .returning()
        if (row === undefined) {
            throw new Error('user_preferences upsert returned no row')
        }
        return row
    },
}
