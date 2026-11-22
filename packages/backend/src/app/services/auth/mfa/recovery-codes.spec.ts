import { describe, expect, it, vi } from 'vitest'

vi.mock('#config/auth.js', () => ({ authConfig: { otpHmacKey: 'h'.repeat(32) } }))

const {
    RECOVERY_CODE_COUNT,
    generateRecoveryCode,
    generateRecoveryCodes,
    hashRecoveryCode,
    normalizeRecoveryCode,
} = await import('./recovery-codes.js')

describe('recovery codes (feat-245 Р8)', () => {
    it('16 Crockford base32 characters in four groups, 80 bits', () => {
        for (let i = 0; i < 200; i++) {
            const code = generateRecoveryCode()
            expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/)
        }
        // 32 symbols (5 bits) × 16 = 80 bits.
        expect(Math.log2(32) * 16).toBe(80)
    })

    it('a batch is ten distinct codes', () => {
        const codes = generateRecoveryCodes()
        expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
        expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT)
    })

    it('typing: case, spaces, hyphens and look-alikes do not matter', () => {
        const normalized = 'ab0cd1efgh2jkm3n'
        expect(normalizeRecoveryCode('ab0c-d1ef-gh2j-km3n')).toBe(normalized)
        expect(normalizeRecoveryCode(' AB0C D1EF-GH2J KM3N ')).toBe(normalized)
        expect(normalizeRecoveryCode('abOc-dlef-gh2j-km3n')).toBe(normalized)
        expect(normalizeRecoveryCode('abIc-d1ef-gh2j-km3n')).toBe('ab1cd1efgh2jkm3n')
    })

    it('anything else is not a code', () => {
        expect(normalizeRecoveryCode('')).toBeNull()
        expect(normalizeRecoveryCode('abcd-efgh-jkmn')).toBeNull()
        expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqrs-t')).toBeNull()
        expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqr!')).toBeNull()
        expect(normalizeRecoveryCode('abcd-efgh-jkmn-pqru')).toBeNull()
    })

    it('the stored hash is a keyed HMAC, not the code', () => {
        const hash = hashRecoveryCode('ab0cd1efgh2jkm3n')
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
        expect(hash).not.toContain('ab0cd1efgh2jkm3n')
        expect(hashRecoveryCode('ab0cd1efgh2jkm3n')).toBe(hash)
        expect(hashRecoveryCode('ab0cd1efgh2jkm3p')).not.toBe(hash)
    })
})
