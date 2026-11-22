import { describe, expect, it } from 'vitest'

import { parseMfaEncryptionKeys } from './mfa.js'

const b64 = (byte: number, length = 32): string => Buffer.alloc(length, byte).toString('base64')

describe('parseMfaEncryptionKeys (feat-245 Р9)', () => {
    it('reads one key and several keys; the first one is first', () => {
        const one = parseMfaEncryptionKeys(`k1:${b64(1)}`, {
            isProductionLike: true,
            appKey: undefined,
        })
        expect(one.error).toBeNull()
        expect(one.keys.map((k) => k.id)).toEqual(['k1'])
        expect(one.keys[0]?.key.length).toBe(32)

        const two = parseMfaEncryptionKeys(` k2:${b64(2)} , k1:${b64(1)} `, {
            isProductionLike: true,
            appKey: undefined,
        })
        expect(two.error).toBeNull()
        expect(two.keys.map((k) => k.id)).toEqual(['k2', 'k1'])
        expect(two.derived).toBe(false)
    })

    it('requires the keys in a production-like environment', () => {
        const parsed = parseMfaEncryptionKeys('', {
            isProductionLike: true,
            appKey: 'x'.repeat(32),
        })
        expect(parsed.error).toMatch(/required in a production-like/)
        expect(parsed.keys).toEqual([])
    })

    it('derives a stable key from APP_KEY elsewhere; without APP_KEY there is no key', () => {
        const a = parseMfaEncryptionKeys(undefined, {
            isProductionLike: false,
            appKey: 'app-key-a'.repeat(4),
        })
        const again = parseMfaEncryptionKeys(undefined, {
            isProductionLike: false,
            appKey: 'app-key-a'.repeat(4),
        })
        const b = parseMfaEncryptionKeys(undefined, {
            isProductionLike: false,
            appKey: 'app-key-b'.repeat(4),
        })
        expect(a.error).toBeNull()
        expect(a.derived).toBe(true)
        expect(a.keys[0]?.key.equals(again.keys[0]?.key ?? Buffer.alloc(0))).toBe(true)
        expect(a.keys[0]?.key.equals(b.keys[0]?.key ?? Buffer.alloc(0))).toBe(false)
        expect(parseMfaEncryptionKeys('', { isProductionLike: false, appKey: undefined })).toEqual({
            keys: [],
            derived: false,
            error: null,
        })
    })

    it('refuses a bad id, a short key, broken base64 and a repeated id', () => {
        const ctx = { isProductionLike: true, appKey: undefined }
        expect(parseMfaEncryptionKeys(b64(1), ctx).error).toMatch(/<keyId>:<base64>/)
        expect(parseMfaEncryptionKeys(`bad id:${b64(1)}`, ctx).error).toMatch(/<keyId>/)
        expect(parseMfaEncryptionKeys(`k1:${b64(1, 16)}`, ctx).error).toMatch(/32 bytes/)
        expect(parseMfaEncryptionKeys('k1:not*base64', ctx).error).toMatch(/32 bytes/)
        expect(parseMfaEncryptionKeys(`k1:${b64(1)},k1:${b64(2)}`, ctx).error).toMatch(/repeated/)
    })
})
