import { randomBytes } from 'node:crypto'

import { DEV_KEY_ID, deriveDevMfaKey, parseMfaEncryptionKeys } from '../config/mfa.js'

// feat-260: the key list of MFA_ENCRYPTION_KEYS, `<keyId>:<base64 of 32 bytes>[,…]`. The first key
// encrypts the new TOTP secrets, every key reads, so a rotation puts a new key first and keeps the
// old ones: a secret sealed with a key that is dropped can no longer be read.

const KEY_BYTES = 32
/** The server's limit of a key id (KEY_ID_PATTERN in config/mfa.ts). */
const MAX_ID_LENGTH = 16

type Random = (size: number) => Buffer

export type CheckedKeys = { ok: true; ids: string[] } | { ok: false; error: string }

/** Validates a value with the parser the server uses, as a production-like start would. */
export function checkMfaKeys(value: string): CheckedKeys {
    const parsed = parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined })
    if (parsed.error !== null) return { ok: false, error: parsed.error }
    return { ok: true, ids: parsed.keys.map((key) => key.id) }
}

/**
 * `k<n>` one above the highest `k<n>` in use, `k1` for an empty list. When that id would pass the
 * server's 16 characters, the smallest free `k<n>` instead.
 */
export function nextKeyId(ids: readonly string[]): string {
    let highest = 0
    for (const id of ids) {
        const match = /^k(\d+)$/.exec(id)
        if (match !== null) highest = Math.max(highest, Number(match[1]))
    }
    const above = `k${String(highest + 1)}`
    if (above.length <= MAX_ID_LENGTH && !ids.includes(above)) return above
    let next = 1
    while (ids.includes(`k${String(next)}`)) next += 1
    return `k${String(next)}`
}

const keyEntry = (id: string, random: Random): string =>
    `${id}:${random(KEY_BYTES).toString('base64')}`

export type PlannedKeys = { ok: true; value: string; note: string } | { ok: false; error: string }

/** The result, checked as a whole by the server's parser before it is printed or written. */
const checked = (value: string, note: string): PlannedKeys => {
    const result = checkMfaKeys(value)
    if (!result.ok) return { ok: false, error: `the result is invalid: ${result.error}` }
    return { ok: true, value, note }
}

/**
 * A first value: one new key, `k1`. `keepDevFrom` is the APP_KEY of the environment the value is
 * written to: there a start with an empty value derived the `dev` key from it and may have sealed
 * TOTP secrets with it, so that key stays as a reading key after the new one.
 */
export function newMfaKeys(
    options: { keepDevFrom?: string | undefined; random?: Random } = {},
): PlannedKeys {
    const random = options.random ?? randomBytes
    const entry = keyEntry('k1', random)
    const appKey = options.keepDevFrom ?? ''
    if (appKey === '') return checked(entry, 'One key, "k1".')
    const dev = `${DEV_KEY_ID}:${deriveDevMfaKey(appKey).toString('base64')}`
    return checked(
        `${entry},${dev}`,
        `New key "k1" encrypts; "${DEV_KEY_ID}", the key derived from APP_KEY that a start ` +
            'without MFA_ENCRYPTION_KEYS used, still reads what it sealed.',
    )
}

/**
 * The value with a new key first and every current key kept, in order. Refuses an invalid or
 * empty current value: there is nothing to keep, and a broken entry must not be carried on.
 */
export function rotateMfaKeys(current: string, random: Random = randomBytes): PlannedKeys {
    if (current.trim() === '') {
        return { ok: false, error: 'MFA_ENCRYPTION_KEYS is empty: there is nothing to rotate' }
    }
    const currentKeys = checkMfaKeys(current)
    if (!currentKeys.ok) return currentKeys
    const id = nextKeyId(currentKeys.ids)
    const kept = current
        .split(',')
        .map((entry) => entry.trim())
        .join(',')
    return checked(
        `${keyEntry(id, random)},${kept}`,
        `New key "${id}" encrypts from now on; every key before it still reads.`,
    )
}
