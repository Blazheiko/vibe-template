import { Result } from 'better-result'
import { authConfig } from '#config/auth.js'
import { smsAuthChallengeRepository, type SmsAuthChallengeRow } from '#app/repositories/index.js'
import { smsVerificationProvider } from '#app/services/auth/sms-verification-provider.js'
import { badRequest, type AppResult } from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { hashOtpVerificationCode, verifyOtpVerificationCode } from './otp-verification-hash.js'
import { PENDING_SMS_CODE_HASH_PLACEHOLDER } from './sms-auth-challenge-constants.js'
import { buildResendCooldownError } from './sms-auth-challenge-metadata.js'
import type { SmsVerificationFlow } from './sms-verification-provider.js'

// The three SMS flows (phone registration, phone linking, phone password reset) run the same
// challenge: a row that waits for a code, a code sent by SMS, a code checked with a budget of
// wrong tries. What differs is what a confirmed challenge allows and the words of the answers.

type Metadata = Record<string, unknown>

/**
 * The challenge of this phone and flow that is still waiting, if any. A challenge whose resend
 * time has not come answers 429 with the seconds to wait: nobody gets a second code that early.
 */
export async function findPendingChallenge(
    phone: string,
    flow: SmsVerificationFlow,
    failure: string,
): Promise<AppResult<SmsAuthChallengeRow | undefined>> {
    const pending = await tryInternal(
        () => smsAuthChallengeRepository.findLatestPendingForPhoneFlow(phone, flow),
        failure,
    )
    if (Result.isError(pending)) {
        return Result.err(pending.error)
    }

    if (pending.value !== undefined && pending.value.resendAvailableAt.getTime() > Date.now()) {
        return Result.err(buildResendCooldownError(pending.value.resendAvailableAt))
    }

    return Result.ok(pending.value)
}

/**
 * Retires the waiting challenges of this phone and flow and stores a new one with a code hash of
 * the caller's choosing (the placeholder until a code is sent; a hash nobody can match for a
 * "blind" challenge that hides whether the number is known). Expiry and the earliest resend come
 * from the configuration.
 */
export async function openChallenge(options: {
    phone: string
    flow: SmsVerificationFlow
    codeHash?: string
    metadata: Metadata
    /** Public message of the 500 when the row cannot be stored. */
    failure: string
}): Promise<AppResult<SmsAuthChallengeRow>> {
    await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(options.phone, options.flow)

    const now = Date.now()
    return await tryInternal(
        () =>
            smsAuthChallengeRepository.create({
                flow: options.flow,
                phone: options.phone,
                codeHash: options.codeHash ?? PENDING_SMS_CODE_HASH_PLACEHOLDER,
                expiresAt: new Date(now + authConfig.smsChallengeTtlSeconds * 1000),
                resendAvailableAt: new Date(now + authConfig.smsResendCooldownSeconds * 1000),
                providerRequestId: null,
                metadata: options.metadata,
            }),
        options.failure,
    )
}

/**
 * Sends the code for a stored challenge and records its hash. Whatever goes wrong after the
 * challenge exists leaves no live challenge behind: the provider failing, the row not being
 * updated, or the row having been invalidated meanwhile each invalidate it.
 */
export async function deliverChallenge(
    challenge: SmsAuthChallengeRow,
    options: {
        phone: string
        flow: SmsVerificationFlow
        metadata: Metadata
        failures: {
            /** Public message of the 500 when the provider fails. */
            issue: string
            /** Public message of the 500 when the issued code cannot be recorded. */
            markIssued: string
        }
        /** The 400 when the challenge was invalidated before the code could be recorded. */
        noLongerValid: string
    },
): Promise<AppResult<SmsAuthChallengeRow>> {
    const issued = await tryInternal(
        () =>
            smsVerificationProvider.issueVerificationCode({
                phone: options.phone,
                flow: options.flow,
            }),
        options.failures.issue,
    )
    if (Result.isError(issued)) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
        return Result.err(issued.error)
    }

    const recorded = await tryInternal(
        () =>
            smsAuthChallengeRepository.markIssued(challenge.id, {
                codeHash: hashOtpVerificationCode(issued.value.code),
                providerRequestId: issued.value.providerRequestId,
                metadata: options.metadata,
            }),
        options.failures.markIssued,
    )
    if (Result.isError(recorded)) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
        return Result.err(recorded.error)
    }
    if (recorded.value === undefined) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
        return Result.err(badRequest(options.noLongerValid))
    }

    return Result.ok(recorded.value)
}

/** `openChallenge` and `deliverChallenge` in one: the usual start of an SMS flow. */
export async function issueSmsChallenge(options: {
    phone: string
    flow: SmsVerificationFlow
    metadata: Metadata
    failures: { create: string; issue: string; markIssued: string }
    noLongerValid: string
}): Promise<AppResult<SmsAuthChallengeRow>> {
    const opened = await openChallenge({
        phone: options.phone,
        flow: options.flow,
        metadata: options.metadata,
        failure: options.failures.create,
    })
    if (Result.isError(opened)) {
        return Result.err(opened.error)
    }

    return await deliverChallenge(opened.value, {
        phone: options.phone,
        flow: options.flow,
        metadata: options.metadata,
        failures: { issue: options.failures.issue, markIssued: options.failures.markIssued },
        noLongerValid: options.noLongerValid,
    })
}

/**
 * Checks the code the user typed. A wrong code costs one try; the try that exhausts the budget
 * invalidates the challenge. Answers `Invalid verification code` for a wrong code.
 */
export async function verifySmsCode(
    challenge: SmsAuthChallengeRow,
    code: string,
): Promise<AppResult<void>> {
    if (verifyOtpVerificationCode(code, challenge.codeHash)) {
        return Result.ok(undefined)
    }

    const updated = await smsAuthChallengeRepository.incrementAttemptCount(challenge.id)
    if ((updated?.attemptCount ?? challenge.attemptCount + 1) >= authConfig.smsMaxInvalidAttempts) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
    }

    return Result.err(badRequest('Invalid verification code'))
}

/** Marks the challenge confirmed; a challenge that stopped being valid meanwhile answers 400. */
export async function confirmChallenge(
    challenge: SmsAuthChallengeRow,
    answers: { failure: string; noLongerValid: string },
): Promise<AppResult<void>> {
    const confirmed = await tryInternal(
        () => smsAuthChallengeRepository.markConfirmed(challenge.id),
        answers.failure,
    )
    if (Result.isError(confirmed)) {
        return Result.err(confirmed.error)
    }
    if (confirmed.value === undefined) {
        return Result.err(badRequest(answers.noLongerValid))
    }

    return Result.ok(undefined)
}
