import { FONT_SIZE_MAX, FONT_SIZE_MIN, isColorTheme, isShippedLocale, isTheme } from 'shared/enums'
import { isAllowedTimeZone } from 'shared/utils'
import type { Profile, ProfilePreferences } from 'shared'
import type { UserPreferencesRow } from '#app/repositories/index.js'

const NO_PREFERENCES: ProfilePreferences = {
    locale: null,
    timeZone: null,
    theme: null,
    colorTheme: null,
    fontSize: null,
}

const fontSizeOrNull = (value: number | null): number | null =>
    value !== null && Number.isInteger(value) && value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX
        ? value
        : null

export const profileTransformer = {
    /**
     * A stored value the current code no longer accepts reads as `null` (no choice), never as an
     * error: a language removed from the interface, a zone a newer ICU does not know (Р3).
     */
    serializePreferences(row: UserPreferencesRow | undefined): ProfilePreferences {
        if (row === undefined) return { ...NO_PREFERENCES }
        return {
            locale: row.locale !== null && isShippedLocale(row.locale) ? row.locale : null,
            timeZone: isAllowedTimeZone(row.timeZone) ? row.timeZone : null,
            theme: isTheme(row.theme) ? row.theme : null,
            colorTheme: isColorTheme(row.colorTheme) ? row.colorTheme : null,
            fontSize: fontSizeOrNull(row.fontSize),
        }
    },

    /** `revision` is `"0"` while the user has no row (Р12). */
    serialize(name: string, row: UserPreferencesRow | undefined): Profile {
        return {
            name,
            preferences: profileTransformer.serializePreferences(row),
            revision: row === undefined ? '0' : String(row.revision),
        }
    },
}
