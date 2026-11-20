import { createHash } from 'node:crypto'
import type { AuditContentFingerprint } from 'shared/audit'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * A text as the audit log keeps it (feat-235, Р5): whether it changed, its SHA-256 and its length,
 * never the text. `null` on the side that has no text (a created or a deleted article).
 */
export function contentFingerprint(
    before: string | null,
    after: string | null,
): AuditContentFingerprint {
    return {
        changed: before !== after,
        sha256Before: before === null ? null : sha256(before),
        sha256After: after === null ? null : sha256(after),
        charsBefore: before === null ? null : before.length,
        charsAfter: after === null ? null : after.length,
    }
}
