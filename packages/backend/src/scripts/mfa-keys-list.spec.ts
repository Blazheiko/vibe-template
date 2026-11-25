import { describe, expect, it } from 'vitest'

import { parseMfaEncryptionKeys } from '../config/mfa.js'

import { checkMfaKeys, newMfaKeys, nextKeyId, rotateMfaKeys } from './mfa-keys-list.js'

const fixed =
    (byte: number) =>
    (size: number): Buffer =>
        Buffer.alloc(size, byte)
const b64 = (byte: number): string => Buffer.alloc(32, byte).toString('base64')
const parse = (value: string) =>
    parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined })

describe('mfa:keys key list (feat-260)', () => {
    it('a new value is one 32-byte key k1 the server accepts', () => {
        const value = newMfaKeys()
        const parsed = parse(value)
        expect(parsed.error).toBeNull()
        expect(parsed.keys.map((key) => key.id)).toEqual(['k1'])
        expect(parsed.keys[0]?.key.length).toBe(32)
        // Random: two runs differ.
        expect(newMfaKeys()).not.toBe(value)
    })

    it('the next id is one above the highest k<n>, other ids ignored', () => {
        expect(nextKeyId([])).toBe('k1')
        expect(nextKeyId(['k1'])).toBe('k2')
        expect(nextKeyId(['k3', 'k1'])).toBe('k4')
        expect(nextKeyId(['main', 'old-2024'])).toBe('k1')
        expect(nextKeyId(['k01'])).toBe('k2')
    })

    it('a rotation puts the new key first and keeps every current key in order', () => {
        const current = ` k2:${b64(2)} , k1:${b64(1)} `
        const rotated = rotateMfaKeys(current, fixed(3))
        expect(rotated).toEqual({
            ok: true,
            id: 'k3',
            value: `k3:${b64(3)},k2:${b64(2)},k1:${b64(1)}`,
        })
        const parsed = parse(rotated.ok ? rotated.value : '')
        expect(parsed.error).toBeNull()
        expect(parsed.keys.map((key) => key.id)).toEqual(['k3', 'k2', 'k1'])
        // The kept keys are the same bytes: what they sealed still opens.
        expect(parsed.keys[1]?.key.equals(Buffer.alloc(32, 2))).toBe(true)
        expect(parsed.keys[2]?.key.equals(Buffer.alloc(32, 1))).toBe(true)
    })

    it('a rotation refuses an empty or an invalid current value', () => {
        expect(rotateMfaKeys('  ')).toEqual({
            ok: false,
            error: 'MFA_ENCRYPTION_KEYS is empty: there is nothing to rotate',
        })
        const broken = rotateMfaKeys(`k1:${b64(1)},k1:${b64(2)}`)
        expect(broken).toEqual({
            ok: false,
            error: 'MFA_ENCRYPTION_KEYS: the key id "k1" is repeated',
        })
        expect(rotateMfaKeys('k1:short').ok).toBe(false)
    })

    it('a check validates as a production-like start would', () => {
        expect(checkMfaKeys(`k2:${b64(2)},k1:${b64(1)}`)).toEqual({ ok: true, ids: ['k2', 'k1'] })
        expect(checkMfaKeys('')).toEqual({
            ok: false,
            error: 'MFA_ENCRYPTION_KEYS is required in a production-like environment',
        })
        expect(checkMfaKeys('no-separator').ok).toBe(false)
    })
})
