import { describe, expect, it } from 'vitest'

import {
    hashOtpCode,
    hashRecoveryCode,
    hashToken,
    mfaBindingOf,
    newMfaBindValue,
    newRawToken,
    normalizeRecoveryCode,
    otpCodeMatches,
    otpCodeOf,
    rawRecoveryCodeOf,
    type MfaBinding,
    type OtpHash,
    type RawToken,
    type TokenHash,
} from './secrets.js'
import type { ITokenRepository } from '#app/repositories/index.js'

const KEY = 'k'.repeat(32)

// feat-265 (ADR 0007, plan Р5): each state of a secret is its own type. The type cases are checked
// by the compiler; the calls behind `() =>` are never run.
describe('secrets typed by state', () => {
    it('a raw token is hashed, and a lookup takes only the hash', () => {
        const raw = newRawToken()
        const hash = hashToken(raw)
        const repository = {} as Pick<ITokenRepository<unknown, never>, 'findByTokenHash'>
        const typeCases = () => [
            repository.findByTokenHash(hash),
            // @ts-expect-error a raw token is not a token hash
            repository.findByTokenHash(raw),
            // @ts-expect-error a hash is not hashed again
            hashToken(hash),
            // @ts-expect-error plain text is not a raw token before rawTokenOf
            hashToken('abc'),
        ]
        expect(typeof typeCases).toBe('function')
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hashToken(raw)).toBe(hash)
    })

    it('an OTP code and its hash are not interchangeable', () => {
        const code = otpCodeOf('123456')
        const hash: OtpHash = hashOtpCode(KEY, code)
        const typeCases = () => [
            otpCodeMatches(KEY, code, hash),
            // @ts-expect-error the hash is not the code
            otpCodeMatches(KEY, hash, hash),
            // @ts-expect-error the code is not the expected hash
            otpCodeMatches(KEY, code, code),
        ]
        expect(typeof typeCases).toBe('function')
        expect(otpCodeMatches(KEY, code, hash)).toBe(true)
        expect(otpCodeMatches(KEY, otpCodeOf('654321'), hash)).toBe(false)
    })

    it('a recovery code is hashed only in its normalized form', () => {
        const raw = rawRecoveryCodeOf('AB0C-D1EF-GH2J-KM3N')
        const normalized = normalizeRecoveryCode(raw)
        if (normalized === null) throw new Error('the code should normalize')
        const typeCases = () => [
            hashRecoveryCode(KEY, normalized),
            // @ts-expect-error a raw code is hashed only after normalizeRecoveryCode
            hashRecoveryCode(KEY, raw),
        ]
        expect(typeof typeCases).toBe('function')
        expect(normalized).toBe('ab0cd1efgh2jkm3n')
        expect(hashRecoveryCode(KEY, normalized)).not.toContain(normalized)
    })

    it('the mfa_bind value and its binding do not mix up', () => {
        const value = newMfaBindValue()
        const binding: MfaBinding = mfaBindingOf(KEY, value)
        const typeCases = (): unknown[] => [
            // @ts-expect-error a binding is not a cookie value
            mfaBindingOf(KEY, binding),
            // @ts-expect-error a cookie value is not a binding
            ((b: MfaBinding) => b)(value),
        ]
        expect(typeof typeCases).toBe('function')
        expect(mfaBindingOf(KEY, value)).toBe(binding)
    })

    it('unbranded text is refused where a brand is expected', () => {
        // @ts-expect-error a string is not a RawToken
        const raw: RawToken = 'abc'
        // @ts-expect-error a string is not a TokenHash
        const hash: TokenHash = 'abc'
        expect([raw, hash]).toHaveLength(2)
    })
})
