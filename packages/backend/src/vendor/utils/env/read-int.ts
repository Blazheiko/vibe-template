export interface IntRange {
    min: number
    max?: number
}

const DECIMAL = /^\d+$/

/**
 * The one reading of an integer environment variable (documentation/backend/configuration.md).
 *
 * - decimal digits only, so not `1e3`, `0x10`, `-5`, `+5`, `1.5` (`Number()` takes all of them)
 * - within `range` (inclusive) and a safe integer
 * - missing or blank -> `fallback`
 * - anything else -> a config error naming the variable
 *
 * @returns `value` is the fallback when `error` is set
 */
export function parseInteger(
    name: string,
    raw: string | undefined,
    fallback: number,
    range: IntRange,
): { value: number; error: string | null } {
    if (raw === undefined || raw.trim() === '') return { value: fallback, error: null }
    const text = raw.trim()
    const parsed = DECIMAL.test(text) ? Number(text) : Number.NaN
    const tooBig = range.max !== undefined && parsed > range.max
    if (!Number.isSafeInteger(parsed) || parsed < range.min || tooBig) {
        const expected =
            range.max === undefined
                ? `>= ${String(range.min)}`
                : `from ${String(range.min)} to ${String(range.max)}`
        return { value: fallback, error: `${name} must be an integer ${expected}, got "${raw}"` }
    }
    return { value: parsed, error: null }
}
