// Seed errors may carry user data: DrizzleQueryError puts the query params (email, password
// hash, session token) into `message`, and a pg error's `detail` / `message` can quote values.
// Only an allowlist of structural fields is printed, the same one the runtime logger keeps
// (vendor/utils/errors/scrub-error.ts).
import { SAFE_DB_ERROR_FIELDS } from '#vendor/utils/errors/scrub-error.js'

const SAFE_FIELDS = SAFE_DB_ERROR_FIELDS

// Node system errors (ECONNREFUSED, ENOTFOUND, ...) have messages without user data.
const isSystemError = (code: unknown): boolean => typeof code === 'string' && /^E[A-Z]+$/.test(code)

function describeOne(err: unknown): string {
    if (!(err instanceof Error)) return 'non-Error value thrown'
    const record = err as unknown as Record<string, unknown>
    const parts = [err.name]
    for (const field of SAFE_FIELDS) {
        const value = record[field]
        if (typeof value === 'string' && value !== '') parts.push(`${field}=${value}`)
    }
    if (isSystemError(record['code'])) parts.push(err.message)
    return parts.join(' ')
}

export function describeSeedError(err: unknown): string {
    const lines = [describeOne(err)]
    let cause = err instanceof Error ? err.cause : undefined
    while (cause !== undefined && lines.length < 5) {
        lines.push(`caused by: ${describeOne(cause)}`)
        cause = cause instanceof Error ? cause.cause : undefined
    }
    return lines.join('\n')
}

export function reportSeedFailure(err: unknown): void {
    console.error(`Seed failed, nothing was written:\n${describeSeedError(err)}`)
}
