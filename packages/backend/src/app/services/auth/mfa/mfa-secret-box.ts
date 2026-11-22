import mfaConfig from '#config/mfa.js'
import { createSecretBox, type SecretBox } from '#app/services/shared/secret-box.js'

// feat-245 (Р9): the box of the TOTP secrets, built once from MFA_ENCRYPTION_KEYS. Null when no
// key is configured (a local setup without APP_KEY): the TOTP flows answer 503 then.
let box: SecretBox | null | undefined

export function mfaSecretBox(): SecretBox | null {
    if (box === undefined) {
        box = mfaConfig.encryptionKeys.length > 0 ? createSecretBox(mfaConfig.encryptionKeys) : null
    }
    return box
}

/** The associated data that binds a sealed TOTP secret to its owner. */
export const totpSecretOwner = (userId: bigint): string => `totp:${String(userId)}`
