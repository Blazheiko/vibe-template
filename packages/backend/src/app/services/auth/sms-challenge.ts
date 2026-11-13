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
import {
    buildResendCooldownError,
    extractChallengeSessionId,
} from './sms-auth-challenge-metadata.js'
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

/** What `openSessionChallenge` did not open, and why. */
export const SESSION_CHALLENGES_FULL = 'full' as const

/**
 * feat-204 (security review 2026-11-12, L-3): a challenge of this phone and flow that belongs
 * to one browser session and lives next to the challenges of other sessions.
 *
 * `openChallenge` keeps one live challenge per phone and flow, so the first to start a phone
 * password reset held the only one: the owner's own start got no `challengeId`, and the codes
 * that reached their phone were useless. Here a start retires only the waiting challenges of
 * its own session (and expired leftovers); the others stay, so nobody can cancel a reset they
 * did not start. At most `maxLive` live challenges exist per phone and flow: one more start
 * from yet another session opens nothing and answers `SESSION_CHALLENGES_FULL`.
 *
 * Like `openChallenge`: one transaction under the advisory lock of the phone and flow, with
 * the resend cooldown (of the newest challenge, whoever started it) checked inside.
 *
 * feat-212: the budget of the start is spent here too (`spendBudget`), after those checks. It
 * used to be spent by the caller before the lock, on the word of a check made outside it: of
 * a burst of parallel starts all passed that check and all paid, though the lock let one in.
 */
export async function openSessionChallenge(options: {
    phone: string
    flow: SmsVerificationFlow
    codeHash?: string
    metadata: Metadata
    /** The session that starts; null owns nothing and can replace nothing. */
    sessionId: string | null
    maxLive: number
    /**
     * feat-212: what a start that will really open a challenge pays (the hourly SMS budget of
     * the number). Called under the lock, after the cooldown and the capacity were checked, so
     * a start those refuse pays nothing; an error here opens nothing and is the answer.
     */
    spendBudget?: () => Promise<AppResult<void>>
}): Promise<AppResult<SmsAuthChallengeRow | typeof SESSION_CHALLENGES_FULL>> {
    return await withTransaction(async (tx) => {
        await smsAuthChallengeRepository.lockPhoneFlow(options.phone, options.flow, tx)
        const pending = await smsAuthChallengeRepository.findPendingForPhoneFlow(
            options.phone,
            options.flow,
            tx,
        )
        const now = Date.now()
        const newest = pending[0]
        if (newest !== undefined && newest.resendAvailableAt.getTime() > now) {
            return Result.err(buildResendCooldownError(newest.resendAvailableAt))
        }

        const { own, others, expired } = splitSessionChallenges(pending, options.sessionId, now)
        if (others.length + 1 > options.maxLive) return Result.ok(SESSION_CHALLENGES_FULL)

        if (options.spendBudget !== undefined) {
            const spent = await options.spendBudget()
            if (Result.isError(spent)) return Result.err(spent.error)
        }

        await smsAuthChallengeRepository.invalidatePendingByIds(
            [...own, ...expired].map((challenge) => challenge.id),
            tx,
        )
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

/** The waiting challenges of a phone and flow, by whose they are for `sessionId`. */
export function splitSessionChallenges(
    pending: readonly SmsAuthChallengeRow[],
    sessionId: string | null,
    now: number,
): { own: SmsAuthChallengeRow[]; others: SmsAuthChallengeRow[]; expired: SmsAuthChallengeRow[] } {
    const own: SmsAuthChallengeRow[] = []
    const others: SmsAuthChallengeRow[] = []
    const expired: SmsAuthChallengeRow[] = []
    for (const challenge of pending) {
        if (challenge.expiresAt.getTime() <= now) expired.push(challenge)
        else if (sessionId !== null && extractChallengeSessionId(challenge.metadata) === sessionId)
            own.push(challenge)
        else others.push(challenge)
    }
    return { own, others, expired }
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
