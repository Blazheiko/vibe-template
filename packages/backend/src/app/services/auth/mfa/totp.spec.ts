import { describe, expect, it } from 'vitest'

import {
    base32Decode,
    base32Encode,
    generateTotpSecret,
    hotp,
    matchTotpStep,
    otpauthUri,
    totpStepAt,
} from './totp.js'

// RFC 6238, Appendix B: the seeds and the 8-digit codes for each time and algorithm.
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii')
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii')
const SEED_SHA512 = Buffer.from(
    '1234567890123456789012345678901234567890123456789012345678901234',
    'ascii',
)
const VECTORS: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
]

describe('TOTP (feat-245 Р7, RFC 6238)', () => {
    it.each(VECTORS)('RFC 6238 Appendix B at T=%i', (seconds, sha1, sha256, sha512) => {
        const step = totpStepAt(seconds * 1000)
        expect(hotp(SEED_SHA1, step, 8, 'sha1')).toBe(sha1)
        expect(hotp(SEED_SHA256, step, 8, 'sha256')).toBe(sha256)
        expect(hotp(SEED_SHA512, step, 8, 'sha512')).toBe(sha512)
    })

    it('RFC 4226 Appendix D: the 6-digit HOTP values of counters 0–9', () => {
        const expected = [
            '755224',
            '287082',
            '359152',
            '969429',
            '338314',
            '254676',
            '287922',
            '162583',
            '399871',
            '520489',
        ]
        expected.forEach((code, counter) => {
            expect(hotp(SEED_SHA1, BigInt(counter))).toBe(code)
        })
    })

    it('accepts the current step and one step either way, and answers which one', () => {
        const secret = generateTotpSecret()
        const now = 1_800_000_000_000
        const step = totpStepAt(now)
        expect(matchTotpStep(secret, hotp(secret, step), now)).toBe(step)
        expect(matchTotpStep(secret, hotp(secret, step - 1n), now)).toBe(step - 1n)
        expect(matchTotpStep(secret, hotp(secret, step + 1n), now)).toBe(step + 1n)
        expect(matchTotpStep(secret, hotp(secret, step - 2n), now)).toBeNull()
        expect(matchTotpStep(secret, hotp(secret, step + 2n), now)).toBeNull()
    })

    it('refuses anything that is not six digits; spaces are ignored', () => {
        const secret = generateTotpSecret()
        const now = 1_800_000_000_000
        const code = hotp(secret, totpStepAt(now))
        expect(matchTotpStep(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(
            totpStepAt(now),
        )
        expect(matchTotpStep(secret, '12345', now)).toBeNull()
        expect(matchTotpStep(secret, '1234567', now)).toBeNull()
        expect(matchTotpStep(secret, 'abcdef', now)).toBeNull()
        expect(matchTotpStep(secret, '', now)).toBeNull()
    })

    it('base32 round trip and the RFC 4648 test vector', () => {
        expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
        expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar')
        const secret = generateTotpSecret()
        expect(secret).toHaveLength(20)
        expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true)
        expect(() => base32Decode('01')).toThrow()
    })

    it('the otpauth URI names the issuer, the account and the profile', () => {
        const uri = otpauthUri(Buffer.from('foobar'), 'Vibe App', 'ann@example.test')
        expect(uri).toBe(
            'otpauth://totp/Vibe%20App:ann%40example.test?secret=MZXW6YTBOI&issuer=Vibe+App&algorithm=SHA1&digits=6&period=30',
        )
    })
})
