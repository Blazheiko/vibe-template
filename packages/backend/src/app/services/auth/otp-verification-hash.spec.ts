import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OtpCode } from '#app/domain/secrets.js'
import { createHash } from 'node:crypto'

const ORIGINAL_ENV = { ...process.env }

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, ORIGINAL_ENV)
}

afterEach(() => {
    vi.resetModules()
    restoreEnv()
})

describe('otp verification hashing', () => {
    it('uses HMAC instead of raw sha256 and verifies correctly', async () => {
        process.env['AUTH_OTP_HMAC_KEY'] = 'b'.repeat(32)
        const { hashOtpVerificationCode, verifyOtpVerificationCode } =
            await import('./otp-verification-hash.js')

        const hash = hashOtpVerificationCode('123456' as OtpCode)
        const rawSha256 = createHash('sha256').update('123456').digest('hex')

        expect(hash).not.toBe(rawSha256)
        expect(verifyOtpVerificationCode('123456' as OtpCode, hash)).toBe(true)
        expect(verifyOtpVerificationCode('654321' as OtpCode, hash)).toBe(false)
    })

    it('throws when no OTP hashing secret is configured', async () => {
        delete process.env['AUTH_OTP_HMAC_KEY']
        delete process.env['APP_KEY']
        const { hashOtpVerificationCode } = await import('./otp-verification-hash.js')

        expect(() => hashOtpVerificationCode('123456' as OtpCode)).toThrow(
            'OTP verification hashing secret is not configured',
        )
    })
})
