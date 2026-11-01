import { Result } from 'better-result'
import { normalizePhoneNumber } from 'shared/utils'
import { badRequest, type AppResult } from '#app/services/shared/errors.js'
import type { SmsVerificationFlow } from './sms-verification-provider.js'

export const REGISTER_PHONE_FLOW: SmsVerificationFlow = 'register_phone'
export const LINK_PHONE_FLOW: SmsVerificationFlow = 'link_phone'
export const RESET_PHONE_FLOW: SmsVerificationFlow = 'reset_phone'

/** The one form of an e-mail address the accounts are looked up and stored by. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
}

/** E.164 form of a phone number, or a 400 with the reason the number is refused. */
export function normalizePhone(input: string, defaultCountry?: string): AppResult<string> {
    try {
        return Result.ok(normalizePhoneNumber(input, defaultCountry))
    } catch (error) {
        if (error instanceof Error) {
            return Result.err(badRequest(error.message))
        }

        return Result.err(badRequest('Phone number must be valid and in a supported format'))
    }
}

/** A challenge is over at its expiry instant, not after it. */
export function isChallengeExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() <= Date.now()
}
