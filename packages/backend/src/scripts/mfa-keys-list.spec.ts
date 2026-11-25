import { describe, expect, it } from 'vitest'

import { deriveDevMfaKey, parseMfaEncryptionKeys } from '../config/mfa.js'

import { checkMfaKeys, newMfaKeys, nextKeyId, rotateMfaKeys } from './mfa-keys-list.js'

const fixed =
    (byte: number) =>
    (size: number): Buffer =>
        Buffer.alloc(size, byte)
const b64 = (byte: number): string => Buffer.alloc(32, byte).toString('base64')
const parse = (value: string) =>
    parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined })
const valueOf = (planned: ReturnType<typeof newMfaKeys>): string => {
    if (!planned.ok) throw new Error(planned.error)
    return planned.value
}

describe('mfa:keys key list (feat-260)', () => {
    it('a new value is one 32-byte key k1 the server accepts', () => {
        const value = valueOf(newMfaKeys())
        const parsed = parse(value)
        expect(parsed.error).toBeNull()
        expect(parsed.keys.map((key) => key.id)).toEqual(['k1'])
        expect(parsed.keys[0]?.key.length).toBe(32)
        // Random: two runs differ.
        expect(valueOf(newMfaKeys())).not.toBe(value)
    })

    it('a first value for an environment with APP_KEY keeps its dev key as a reading key', () => {
        const appKey = 'a'.repeat(32)
        const value = valueOf(newMfaKeys({ keepDevFrom: appKey, random: fixed(4) }))
        const parsed = parse(value)
        expect(parsed.error).toBeNull()
        expect(parsed.keys.map((key) => key.id)).toEqual(['k1', 'dev'])
        expect(parsed.keys[0]?.key.equals(Buffer.alloc(32, 4))).toBe(true)
        // The very key a start without MFA_ENCRYPTION_KEYS derives, so what it sealed opens.
        const derived = parseMfaEncryptionKeys('', { isProductionLike: false, appKey })
        expect(derived.keys[0]?.id).toBe('dev')
        expect(parsed.keys[1]?.key.equals(derived.keys[0]?.key ?? Buffer.alloc(0))).toBe(true)
        expect(parsed.keys[1]?.key.equals(deriveDevMfaKey(appKey))).toBe(true)
        // No APP_KEY: no dev key.
        expect(valueOf(newMfaKeys({ keepDevFrom: '' })).split(',')).toHaveLength(1)
    })

    it('the next id is one above the highest k<n>, other ids ignored', () => {
        expect(nextKeyId([])).toBe('k1')
        expect(nextKeyId(['k1'])).toBe('k2')
        expect(nextKeyId(['k3', 'k1'])).toBe('k4')
        expect(nextKeyId(['main', 'old-2024', 'dev'])).toBe('k1')
        expect(nextKeyId(['k01'])).toBe('k2')
    })

    it('the next id stays within the 16 characters of the server', () => {
        // k999999999999999 is 16 characters; one above would be 17.
        expect(nextKeyId(['k999999999999999'])).toBe('k1')
        expect(nextKeyId(['k999999999999999', 'k1', 'k2'])).toBe('k3')
        const rotated = rotateMfaKeys(`k999999999999999:${b64(1)}`, fixed(2))
        const parsed = parse(valueOf(rotated))
        expect(parsed.error).toBeNull()
        expect(parsed.keys.map((key) => key.id)).toEqual(['k1', 'k999999999999999'])
    })

    it('a rotation puts the new key first and keeps every current key in order', () => {
        const current = ` k2:${b64(2)} , k1:${b64(1)} `
        const rotated = rotateMfaKeys(current, fixed(3))
        expect(rotated).toEqual({
            ok: true,
            value: `k3:${b64(3)},k2:${b64(2)},k1:${b64(1)}`,
            note: 'New key "k3" encrypts from now on; every key before it still reads.',
        })
        const parsed = parse(valueOf(rotated))
        expect(parsed.keys.map((key) => key.id)).toEqual(['k3', 'k2', 'k1'])
        // The kept keys are the same bytes: what they sealed still opens.
        expect(parsed.keys[1]?.key.equals(Buffer.alloc(32, 2))).toBe(true)
        expect(parsed.keys[2]?.key.equals(Buffer.alloc(32, 1))).toBe(true)
        // A dev key is kept like any other.
        expect(
            parse(valueOf(rotateMfaKeys(`k1:${b64(1)},dev:${b64(9)}`))).keys.map((k) => k.id),
        ).toEqual(['k2', 'k1', 'dev'])
    })

    it('a rotation refuses an empty or an invalid current value', () => {
        expect(rotateMfaKeys('  ')).toEqual({
            ok: false,
            error: 'MFA_ENCRYPTION_KEYS is empty: there is nothing to rotate',
        })
        expect(rotateMfaKeys(`k1:${b64(1)},k1:${b64(2)}`)).toEqual({
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
