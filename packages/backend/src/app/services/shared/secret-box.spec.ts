import { describe, expect, it } from 'vitest'

import { createSecretBox, SecretBoxError } from './secret-box.js'

const key = (id: string, byte: number) => ({ id, key: Buffer.alloc(32, byte) })
const secret = Buffer.from('JBSWY3DPEHPK3PXP-secret-bytes')

describe('secret box (feat-245 Р9)', () => {
    it('opens what it sealed for the same owner, with a fresh IV every time', () => {
        const box = createSecretBox([key('k1', 1)])
        const a = box.seal(secret, 'user:1')
        const b = box.seal(secret, 'user:1')
        expect(a.keyId).toBe('k1')
        expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
        expect(a.ciphertext.includes(secret)).toBe(false)
        expect(box.open(a, 'user:1').equals(secret)).toBe(true)
    })

    it('refuses another owner (associated data)', () => {
        const box = createSecretBox([key('k1', 1)])
        const sealed = box.seal(secret, 'user:1')
        expect(() => box.open(sealed, 'user:2')).toThrow(SecretBoxError)
    })

    it('refuses an unknown key and a key with the same id but other bytes', () => {
        const sealed = createSecretBox([key('k1', 1)]).seal(secret, 'user:1')
        expect(() => createSecretBox([key('k2', 2)]).open(sealed, 'user:1')).toThrow(/unknown key/)
        expect(() => createSecretBox([key('k1', 9)]).open(sealed, 'user:1')).toThrow(SecretBoxError)
    })

    it('refuses a tampered or a truncated ciphertext', () => {
        const box = createSecretBox([key('k1', 1)])
        const sealed = box.seal(secret, 'user:1')
        const tampered = Buffer.from(sealed.ciphertext)
        tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
        expect(() => box.open({ ...sealed, ciphertext: tampered }, 'user:1')).toThrow(
            SecretBoxError,
        )
        expect(() => box.open({ ...sealed, ciphertext: Buffer.alloc(10) }, 'user:1')).toThrow(
            /too short/,
        )
    })

    it('rotation: the first key writes, an older key still reads', () => {
        const old = createSecretBox([key('k1', 1)]).seal(secret, 'user:1')
        const rotated = createSecretBox([key('k2', 2), key('k1', 1)])
        expect(rotated.open(old, 'user:1').equals(secret)).toBe(true)
        expect(rotated.seal(secret, 'user:1').keyId).toBe('k2')
    })

    it('needs at least one key', () => {
        expect(() => createSecretBox([])).toThrow(SecretBoxError)
    })
})
