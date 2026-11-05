import { Result } from 'better-result'
import { authConfig } from '#config/auth.js'
import {
    smsAuthChallengeRepository,
    withTransaction,
    type SmsAuthChallengeRow,
} from '#app/repositories/index.js'
import type { DbExecutor } from '#app/repositories/transaction.js'
import { smsVerificationProvider } from '#app/services/auth/sms-verification-provider.js'
import { badRequest, type AppResult } from '#app/services/shared/errors.js'
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
): Promise<AppResult<SmsAuthChallengeRow | undefined>> {
    const pending = await smsAuthChallengeRepository.findLatestPendingForPhoneFlow(phone, flow)

    if (pending !== undefined && pending.resendAvailableAt.getTime() > Date.now()) {
        return Result.err(buildResendCooldownError(pending.resendAvailableAt))
    }

    return Result.ok(pending)
}

/**
 * Retires the waiting challenges of this phone and flow and stores a new one with a code hash of
 * the caller's choosing (the placeholder until a code is sent; a hash nobody can match for a
 * "blind" challenge that hides whether the number is known). Expiry and the earliest resend come
 * from the configuration.
 *
 * feat-134 (L2): one transaction under an advisory lock on the phone and flow, with the cooldown
 * checked again inside it. Two starts that both passed `findPendingChallenge` used to both retire
 * and create, and could leave two live challenges (two SMS, a double budget of tries); now the
 * second waits for the first, sees its challenge and answers the resend cooldown.
 */
export async function openChallenge(options: {
    phone: string
    flow: SmsVerificationFlow
    codeHash?: string
    metadata: Metadata
}): Promise<AppResult<SmsAuthChallengeRow>> {
    return await withTransaction(async (tx) => {
        await smsAuthChallengeRepository.lockPhoneFlow(options.phone, options.flow, tx)
        const pending = await smsAuthChallengeRepository.findLatestPendingForPhoneFlow(
            options.phone,
            options.flow,
            tx,
        )
        if (pending !== undefined && pending.resendAvailableAt.getTime() > Date.now()) {
            return Result.err(buildResendCooldownError(pending.resendAvailableAt))
        }
        await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(
            options.phone,
            options.flow,
            tx,
        )

        const now = Date.now()
        const created = await smsAuthChallengeRepository.create(
            {
                flow: options.flow,
                phone: options.phone,
                codeHash: options.codeHash ?? PENDING_SMS_CODE_HASH_PLACEHOLDER,
                expiresAt: new Date(now + authConfig.smsChallengeTtlSeconds * 1000),
                resendAvailableAt: new Date(now + authConfig.smsResendCooldownSeconds * 1000),
                providerRequestId: null,
                metadata: options.metadata,
            },
            tx,
        )
        return Result.ok(created)
    })
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
        /** The 400 when the challenge was invalidated before the code could be recorded. */
        noLongerValid: string
    },
): Promise<AppResult<SmsAuthChallengeRow>> {
    let recorded: SmsAuthChallengeRow | undefined
    try {
        const issued = await smsVerificationProvider.issueVerificationCode({
            phone: options.phone,
            flow: options.flow,
        })
        recorded = await smsAuthChallengeRepository.markIssued(challenge.id, {
            codeHash: hashOtpVerificationCode(issued.code),
            providerRequestId: issued.providerRequestId,
            metadata: options.metadata,
        })
    } catch (err: unknown) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
        throw err
    }
    if (recorded === undefined) {
        await smsAuthChallengeRepository.markInvalidated(challenge.id)
        return Result.err(badRequest(options.noLongerValid))
    }

    return Result.ok(recorded)
}

/** `openChallenge` and `deliverChallenge` in one: the usual start of an SMS flow. */
export async function issueSmsChallenge(options: {
    phone: string
    flow: SmsVerificationFlow
    metadata: Metadata
    noLongerValid: string
}): Promise<AppResult<SmsAuthChallengeRow>> {
    const opened = await openChallenge({
        phone: options.phone,
        flow: options.flow,
        metadata: options.metadata,
    })
    if (Result.isError(opened)) return Result.err(opened.error)

    return await deliverChallenge(opened.value, {
        phone: options.phone,
        flow: options.flow,
        metadata: options.metadata,
        noLongerValid: options.noLongerValid,
    })
}

/**
 * Checks the code the user typed. Every check spends one try first, in one statement that also
 * re-checks the challenge is still waiting: concurrent requests cannot compare more codes than
 * the budget allows, whatever row they read before. A challenge that stopped waiting (confirmed,
 * invalidated, expired or out of tries) answers `noLongerValid` without a comparison; a wrong code
 * answers `Invalid verification code`, and the try that exhausts the budget invalidates the
 * challenge unless it was confirmed meanwhile. A right code spends its try too.
 */
export async function verifySmsCode(
    challenge: SmsAuthChallengeRow,
    code: string,
    answers: { noLongerValid: string },
    executor?: DbExecutor,
): Promise<AppResult<void>> {
    const spent = await smsAuthChallengeRepository.consumeAttempt(
        challenge.id,
        authConfig.smsMaxInvalidAttempts,
        executor,
    )
    if (spent === undefined) {
        return Result.err(badRequest(answers.noLongerValid))
    }

    if (verifyOtpVerificationCode(code, spent.codeHash)) {
        return Result.ok(undefined)
    }

    if (spent.attemptCount >= authConfig.smsMaxInvalidAttempts) {
        await smsAuthChallengeRepository.markInvalidatedIfPending(challenge.id, executor)
    }

    return Result.err(badRequest('Invalid verification code'))
}

/** Marks the challenge confirmed; a challenge that stopped being valid meanwhile answers 400. */
export async function confirmChallenge(
    challenge: SmsAuthChallengeRow,
    answers: { noLongerValid: string },
    executor?: DbExecutor,
): Promise<AppResult<void>> {
    const confirmed = await smsAuthChallengeRepository.markConfirmed(challenge.id, executor)
    if (confirmed === undefined) {
        return Result.err(badRequest(answers.noLongerValid))
    }

    return Result.ok(undefined)
}
