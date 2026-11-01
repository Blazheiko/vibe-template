import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    isChallengeExpired,
    LINK_PHONE_FLOW,
    normalizeEmail,
    normalizePhone,
    REGISTER_PHONE_FLOW,
    RESET_PHONE_FLOW,
} from './auth-normalize.js'

// feat-071 (H2): the helpers replace copies in auth-service, password-reset-service,
// email-verification-service, oauth-service and the seed. The tables below are what each of those
// copies did before, so the move is checked against them and not against a reading of the code.

afterEach(() => {
    vi.useRealTimers()
})

// What every copy of the e-mail normalisation did.
const legacyNormalizeEmail = (email: string): string => email.trim().toLowerCase()

const EMAILS = [
    'jane@example.com',
    'Jane@Example.COM',
    '  jane@example.com  ',
    '\tJane@Example.com\n',
    ' jane@example.com ',
    ' jane@example.com',
    'ÄÖÜ@Example.DE',
    'İSTANBUL@Example.com',
    'ΣΊΣΥΦΟΣ@example.gr',
    'jane+tag@Example.com',
    'jane@@example.com',
    '',
    '   ',
]

describe('normalizeEmail', () => {
    it.each(EMAILS)('gives what the copies gave for %j', (email) => {
        expect(normalizeEmail(email)).toBe(legacyNormalizeEmail(email))
    })

    it('trims, then lower-cases', () => {
        expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com')
        expect(normalizeEmail(' Jane@Example.COM')).toBe('jane@example.com')
    })

    it('does not touch what is inside the address', () => {
        expect(normalizeEmail('Jane+Tag@Example.com')).toBe('jane+tag@example.com')
        expect(normalizeEmail('a b@example.com')).toBe('a b@example.com')
    })

    it('is idempotent', () => {
        for (const email of EMAILS) {
            expect(normalizeEmail(normalizeEmail(email))).toBe(normalizeEmail(email))
        }
    })
})

describe('normalizePhone', () => {
    it.each([
        ['+380501234567', undefined, '+380501234567'],
        ['  +380 50 123 45 67 ', undefined, '+380501234567'],
        ['+380 (50) 123-45-67', undefined, '+380501234567'],
        ['0501234567', 'UA', '+380501234567'],
        ['(212) 456-7890', 'US', '+12124567890'],
    ])('normalises %j with country %j to %j', (input, country, expected) => {
        const result = normalizePhone(input, country)
        expect(Result.isOk(result) && result.value).toBe(expected)
    })

    it.each([
        ['', undefined, 'Phone number is required'],
        ['   ', undefined, 'Phone number is required'],
        ['nope', undefined, 'Phone number must be valid and in a supported format'],
        ['12345', undefined, 'Phone number must be valid and in a supported format'],
        ['0501234567', undefined, 'Phone number must be valid and in a supported format'],
    ])('refuses %j (country %j) with a 400 saying why', (input, country, message) => {
        const result = normalizePhone(input, country)
        expect(Result.isError(result) && result.error).toEqual({ _tag: 'BadRequest', message })
    })
})

describe('isChallengeExpired', () => {
    it('is over at the expiry instant, not only after it', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2030-01-01T00:00:10.000Z'))
        expect(isChallengeExpired(new Date('2030-01-01T00:00:10.001Z'))).toBe(false)
        expect(isChallengeExpired(new Date('2030-01-01T00:00:10.000Z'))).toBe(true)
        expect(isChallengeExpired(new Date('2030-01-01T00:00:09.999Z'))).toBe(true)
    })
})

describe('flows', () => {
    it('are the values the challenge table stores', () => {
        expect([REGISTER_PHONE_FLOW, LINK_PHONE_FLOW, RESET_PHONE_FLOW]).toEqual([
            'register_phone',
            'link_phone',
            'reset_phone',
        ])
    })
})
