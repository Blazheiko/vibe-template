import { timingSafeEqual } from 'node:crypto'

/**
 * Compares two strings by their UTF-8 bytes in constant time for a given length. Only the
 * comparison: a caller that expects a format (a CSRF token, a hex signature) checks it
 * itself. A length mismatch returns false early, which reveals only the length.
 */
export const safeEqual = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8')
    const right = Buffer.from(b, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
}
