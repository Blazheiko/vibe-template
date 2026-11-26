import { describe, expect, it } from 'vitest'

import type { TotpFactorId } from '#app/domain/ids.js'
import {
    hashToken,
    newMfaCompletionId,
    newMfaReservationId,
    newMfaTicketId,
    newRawToken,
    otpCodeOf,
    sessionBindingHashOf,
    sessionTokenOf,
    type MfaAttemptId,
    type MfaCompletionId,
    type MfaReservationId,
    type MfaTicketId,
    type OtpHash,
    type SessionBindingHash,
    type TokenHash,
} from '#app/domain/secrets.js'
import type { ITotpFactorRepository } from '#app/repositories/auth/totp-factor-repository.js'
import type { verifyOtpVerificationCode as VerifyOtp } from '#app/services/auth/otp-verification-hash.js'
import type { wsSessionRevocation as Revocation } from '#app/services/auth/ws-session-revocation.js'
import { uid } from '../test-support/ids.js'

// feat-271 (ADR 0007, plan Р5, T14, T30): the secrets and the MFA ids the review found without a
// compile-time test. The calls behind `() =>` never run; the compiler checks the cases.

describe('secret brands at their real call sites', () => {
    it('a session binding hash is not a token hash, nor the other way round', () => {
        const binding = sessionBindingHashOf('session-1')
        const tokenHash = hashToken(newRawToken())
        const typeCases = (): unknown[] => [
            // @ts-expect-error the hash of a session id is not the hash of a token
            ((h: TokenHash) => h)(binding),
            // @ts-expect-error the hash of a token is not the binding of a session
            ((h: SessionBindingHash) => h)(tokenHash),
        ]
        expect(typeof typeCases).toBe('function')
        expect(binding).not.toBe(tokenHash)
    })

    it('verifyOtpVerificationCode takes the code first, then its stored hash', () => {
        const verify = (() => false) as typeof VerifyOtp
        const code = otpCodeOf('123456')
        const hash = 'hash' as OtpHash
        const typeCases = (): unknown[] => [
            verify(code, hash),
            // @ts-expect-error the arguments swapped
            verify(hash, code),
            // @ts-expect-error a typed string is not a checked code
            verify('123456', hash),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('isSessionStored takes the session id, then the session token', () => {
        const revocation = {} as typeof Revocation
        const token = sessionTokenOf('token-1')
        const typeCases = (): unknown[] => [
            revocation.isSessionStored('session-1', token),
            // @ts-expect-error the arguments swapped
            revocation.isSessionStored(token, 'session-1'),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('the ids of one MFA sign-in do not stand for each other', () => {
        const ticketId = newMfaTicketId()
        const reservationId = newMfaReservationId()
        const completionId = newMfaCompletionId()
        const typeCases = (): unknown[] => [
            // @ts-expect-error a reservation id is not a ticket id
            ((id: MfaTicketId) => id)(reservationId),
            // @ts-expect-error a completion id is not a reservation id
            ((id: MfaReservationId) => id)(completionId),
            // @ts-expect-error a ticket id is not a completion id
            ((id: MfaCompletionId) => id)(ticketId),
            // @ts-expect-error a completion id is not an attempt id
            ((id: MfaAttemptId) => id)(completionId),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('totpFactorRepository.consumeStep takes the owner first (Р11)', () => {
        const repository = {} as Pick<ITotpFactorRepository, 'consumeStep'>
        const factorId = 5n as TotpFactorId
        const typeCases = (): unknown[] => [
            repository.consumeStep(uid(7), factorId, 100n),
            // @ts-expect-error the owner and the factor swapped
            repository.consumeStep(factorId, uid(7), 100n),
        ]
        expect(typeof typeCases).toBe('function')
    })
})
