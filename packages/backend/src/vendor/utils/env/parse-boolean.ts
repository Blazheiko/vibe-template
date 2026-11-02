const TRUE_VALUES = ['true', '1', 'yes', 'on'] as const
const FALSE_VALUES = ['false', '0', 'no', 'off'] as const

/**
 * The one reading of a boolean environment variable (documentation/backend/configuration.md).
 *
 * - `true`, `1`, `yes`, `on` -> true; `false`, `0`, `no`, `off` -> false (any letter case, outer
 *   whitespace ignored)
 * - missing or blank -> `defaultValue`
 * - anything else -> a config error: a typo must not silently switch a flag
 *
 * @returns `value` is the fallback when `error` is set
 */
export function parseBoolean(
    name: string,
    raw: string | undefined,
    defaultValue: boolean,
): { value: boolean; error: string | null } {
    if (raw === undefined || raw.trim() === '') return { value: defaultValue, error: null }
    const text = raw.trim().toLowerCase()
    if ((TRUE_VALUES as readonly string[]).includes(text)) return { value: true, error: null }
    if ((FALSE_VALUES as readonly string[]).includes(text)) return { value: false, error: null }
    return {
        value: defaultValue,
        error: `${name} must be one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(', ')}, got "${raw}"`,
    }
}
