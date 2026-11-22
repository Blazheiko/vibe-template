import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { MfaEncryptionKey } from '#config/mfa.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р9): AES-256-GCM for secrets at rest (the TOTP
// secrets). The associated data binds a ciphertext to its owner, so a row copied to another user
// does not decrypt there. The first key writes; every key of the list reads, by the id stored with
// the ciphertext, which lets the keys rotate without re-encrypting everything at once.

const IV_BYTES = 12
const TAG_BYTES = 16

export interface SealedSecret {
    /** iv (12) | tag (16) | ciphertext */
    ciphertext: Buffer
    keyId: string
}

export class SecretBoxError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SecretBoxError'
    }
}

export interface SecretBox {
    seal(plaintext: Buffer, associatedData: string): SealedSecret
    /** Throws SecretBoxError for an unknown key, a wrong owner or a tampered ciphertext. */
    open(sealed: SealedSecret, associatedData: string): Buffer
}

export function createSecretBox(keys: readonly MfaEncryptionKey[]): SecretBox {
    const writer = keys[0]
    if (writer === undefined) throw new SecretBoxError('secret box: no key')
    const byId = new Map(keys.map((entry) => [entry.id, entry.key]))

    return {
        seal(plaintext, associatedData): SealedSecret {
            const iv = randomBytes(IV_BYTES)
            const cipher = createCipheriv('aes-256-gcm', writer.key, iv, {
                authTagLength: TAG_BYTES,
            })
            cipher.setAAD(Buffer.from(associatedData, 'utf8'))
            const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
            return {
                ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
                keyId: writer.id,
            }
        },
        open(sealed, associatedData): Buffer {
            const key = byId.get(sealed.keyId)
            if (key === undefined) {
                throw new SecretBoxError(`secret box: unknown key "${sealed.keyId}"`)
            }
            if (sealed.ciphertext.length < IV_BYTES + TAG_BYTES) {
                throw new SecretBoxError('secret box: ciphertext too short')
            }
            const iv = sealed.ciphertext.subarray(0, IV_BYTES)
            const tag = sealed.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
            const body = sealed.ciphertext.subarray(IV_BYTES + TAG_BYTES)
            const decipher = createDecipheriv('aes-256-gcm', key, iv, {
                authTagLength: TAG_BYTES,
            })
            decipher.setAAD(Buffer.from(associatedData, 'utf8'))
            decipher.setAuthTag(tag)
            try {
                return Buffer.concat([decipher.update(body), decipher.final()])
            } catch {
                throw new SecretBoxError('secret box: the ciphertext does not open with this key')
            }
        },
    }
}
