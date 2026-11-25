import { randomBytes } from 'node:crypto'

import { parseMfaEncryptionKeys } from '../config/mfa.js'

// feat-260: the key list of MFA_ENCRYPTION_KEYS, `<keyId>:<base64 of 32 bytes>[,…]`. The first key
// encrypts the new TOTP secrets, every key reads, so a rotation puts a new key first and keeps the
// old ones: a secret sealed with a key that is dropped can no longer be read.

const KEY_BYTES = 32

export type CheckedKeys = { ok: true; ids: string[] } | { ok: false; error: string }

/** Validates a value with the parser the server uses, as a production-like start would. */
export function checkMfaKeys(value: string): CheckedKeys {
    const parsed = parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined })
    if (parsed.error !== null) return { ok: false, error: parsed.error }
    return { ok: true, ids: parsed.keys.map((key) => key.id) }
}

/** `k<n>` one above the highest `k<n>` in use, `k1` for an empty list. */
export function nextKeyId(ids: readonly string[]): string {
    let highest = 0
    for (const id of ids) {
        const match = /^k(\d+)$/.exec(id)
        if (match !== null) highest = Math.max(highest, Number(match[1]))
    }
    let next = highest + 1
    while (ids.includes(`k${String(next)}`)) next += 1
    return `k${String(next)}`
}

export function newKeyEntry(id: string, random: (size: number) => Buffer = randomBytes): string {
    return `${id}:${random(KEY_BYTES).toString('base64')}`
}

/** A first value: one key, `k1`. */
export function newMfaKeys(random?: (size: number) => Buffer): string {
    return newKeyEntry('k1', random)
}

/**
 * The value with a new key first and every current key kept, in order. Refuses an invalid or
 * empty current value: there is nothing to keep, and a broken entry must not be carried on.
 */
export function rotateMfaKeys(
    current: string,
    random?: (size: number) => Buffer,
): { ok: true; value: string; id: string } | { ok: false; error: string } {
    if (current.trim() === '') {
        return { ok: false, error: 'MFA_ENCRYPTION_KEYS is empty: there is nothing to rotate' }
    }
    const checked = checkMfaKeys(current)
    if (!checked.ok) return checked
    const id = nextKeyId(checked.ids)
    const kept = current
        .split(',')
        .map((entry) => entry.trim())
        .join(',')
    return { ok: true, value: `${newKeyEntry(id, random)},${kept}`, id }
}
