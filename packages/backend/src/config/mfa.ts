import { hkdfSync } from 'node:crypto'
import { env } from 'node:process'

import type { StaffFactorMode } from 'shared/mfa'

import appConfig from '#config/app.js'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3, Р4, Р8, Р9): the windows of the MFA flows and
// the keys that encrypt the TOTP secrets at rest.

export interface MfaEncryptionKey {
    /** Stored next to every ciphertext, so a rotated key still reads what it wrote. */
    id: string
    key: Buffer
}

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/
const KEY_BYTES = 32
const DEV_KEY_ID = 'dev'

export interface ParsedMfaKeys {
    keys: MfaEncryptionKey[]
    /** True when the keys were derived from APP_KEY (development only). */
    derived: boolean
    error: string | null
}

/**
 * MFA_ENCRYPTION_KEYS: `<keyId>:<base64 of 32 bytes>[,…]`, the first one writes, every one reads.
 * Required in a production-like environment; elsewhere a key is derived from APP_KEY so a local
 * setup works without it (a warning is logged at start).
 */
export function parseMfaEncryptionKeys(
    raw: string | undefined,
    context: { isProductionLike: boolean; appKey: string | undefined },
): ParsedMfaKeys {
    const value = raw?.trim() ?? ''
    if (value === '') {
        if (context.isProductionLike) {
            return {
                keys: [],
                derived: false,
                error: 'MFA_ENCRYPTION_KEYS is required in a production-like environment',
            }
        }
        // No key at all: the TOTP flows answer 503 until one is configured (createSecretBox
        // refuses an empty list); the rest of a local setup still starts.
        if (context.appKey === undefined || context.appKey === '') {
            return { keys: [], derived: false, error: null }
        }
        const key = Buffer.from(
            hkdfSync('sha256', context.appKey, '', 'mfa-encryption-key-v1', KEY_BYTES),
        )
        return { keys: [{ id: DEV_KEY_ID, key }], derived: true, error: null }
    }

    const keys: MfaEncryptionKey[] = []
    for (const entry of value.split(',')) {
        const separator = entry.indexOf(':')
        const id = separator === -1 ? '' : entry.slice(0, separator).trim()
        const encoded = separator === -1 ? '' : entry.slice(separator + 1).trim()
        if (!KEY_ID_PATTERN.test(id)) {
            return {
                keys: [],
                derived: false,
                error: 'MFA_ENCRYPTION_KEYS: every entry is <keyId>:<base64>, keyId of [A-Za-z0-9_-], at most 16 characters',
            }
        }
        const key = Buffer.from(encoded, 'base64')
        if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
            return {
                keys: [],
                derived: false,
                error: `MFA_ENCRYPTION_KEYS: the key "${id}" must be ${String(KEY_BYTES)} bytes in base64`,
            }
        }
        if (keys.some((existing) => existing.id === id)) {
            return {
                keys: [],
                derived: false,
                error: `MFA_ENCRYPTION_KEYS: the key id "${id}" is repeated`,
            }
        }
        keys.push({ id, key })
    }
    return { keys, derived: false, error: null }
}

/** feat-247 (Р10): MFA_STAFF_FACTOR; only `any` until feat-248 adds the passkey mode. */
export function parseStaffFactor(raw: string | undefined): {
    mode: StaffFactorMode
    error: string | null
} {
    const value = (raw ?? '').trim()
    if (value === '' || value === 'any') return { mode: 'any', error: null }
    return { mode: 'any', error: `MFA_STAFF_FACTOR must be "any", got "${value}"` }
}

const reader = createEnvReader()
const staffFactor = parseStaffFactor(env['MFA_STAFF_FACTOR'])
const parsedKeys = parseMfaEncryptionKeys(env['MFA_ENCRYPTION_KEYS'], {
    isProductionLike: appConfig.isProductionLike,
    appKey: appConfig.key,
})

export default Object.freeze({
    encryptionKeys: parsedKeys.keys,
    /** The keys were derived from APP_KEY because MFA_ENCRYPTION_KEYS is not set (development). */
    encryptionKeysDerived: parsedKeys.derived,
    /** A step-up proof counts this long, in seconds (AUTH_REAUTH_WINDOW_SECONDS, default 300). */
    reauthWindowSeconds: reader.int('AUTH_REAUTH_WINDOW_SECONDS', 300, { min: 30, max: 3600 }),
    /** A recent OAuth sign-in stands for a proof this long (the rule of feat-097), in seconds. */
    oauthRecentSeconds: 600,
    /** Absolute lifetime of a recovery session (MFA_RECOVERY_WINDOW_SECONDS, default 900). */
    recoveryWindowSeconds: reader.int('MFA_RECOVERY_WINDOW_SECONDS', 900, { min: 60, max: 3600 }),
    /** Lifetime of a second-step ticket (MFA_TICKET_TTL_SECONDS, default 300). */
    ticketTtlSeconds: reader.int('MFA_TICKET_TTL_SECONDS', 300, { min: 60, max: 1800 }),
    /** An attempt holds its place in the ticket this long (MFA_RESERVATION_TTL_SECONDS, 30). */
    reservationTtlSeconds: reader.int('MFA_RESERVATION_TTL_SECONDS', 30, { min: 5, max: 300 }),
    /** A TOTP setup stays confirmable this long, in seconds. */
    totpEnrollmentTtlSeconds: 600,
    /**
     * feat-247 (Р10, Р11): a staff role needs a second factor and a recent proof of it to use
     * staff permissions, and a staff role is given only to an account with a factor
     * (MFA_REQUIRED_FOR_STAFF, on by default; `false` only for a transition).
     */
    requiredForStaff: reader.bool('MFA_REQUIRED_FOR_STAFF', true),
    /** Which factor a staff role needs (MFA_STAFF_FACTOR): `any` (TOTP or a passkey). */
    staffFactor: staffFactor.mode,
    /** A staff session's factor proof counts this long (MFA_STAFF_FACTOR_MAX_AGE_HOURS, 12). */
    staffFactorMaxAgeHours: reader.int('MFA_STAFF_FACTOR_MAX_AGE_HOURS', 12, { min: 1, max: 168 }),
    // Last: the reads above have run, so the reader holds every problem.
    configError: parsedKeys.error ?? staffFactor.error ?? reader.error,
})
