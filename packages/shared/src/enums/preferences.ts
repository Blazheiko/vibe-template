/**
 * Interface preferences a user keeps in their profile (`user_preferences`, feat-232). The
 * database `CHECK` constraints, the request schema and the account page read these lists, so a
 * new color theme is added here (and to the frontend styles) and nowhere else.
 */
export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const COLOR_THEMES = ['ocean', 'mint', 'lavender', 'rose', 'sunset', 'monochrome'] as const
export type ColorTheme = (typeof COLOR_THEMES)[number]

/** The color theme shown while the profile has none (`color_theme = NULL`). */
export const DEFAULT_COLOR_THEME: ColorTheme = 'rose'

export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 20
/** The font size shown while the profile has none (`font_size = NULL`). */
export const DEFAULT_FONT_SIZE = 16

export function isTheme(value: unknown): value is Theme {
    return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function isColorTheme(value: unknown): value is ColorTheme {
    return typeof value === 'string' && (COLOR_THEMES as readonly string[]).includes(value)
}

/** Clamps a font size into the allowed range; anything that is not a finite number is the default. */
export function clampFontSize(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FONT_SIZE
    return Math.min(Math.max(Math.round(value), FONT_SIZE_MIN), FONT_SIZE_MAX)
}
