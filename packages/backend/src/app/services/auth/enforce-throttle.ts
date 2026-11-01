import { Result } from 'better-result'
import type { ThrottlePolicy } from '#config/throttle-policies.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import type { AppError, AppResult } from '#app/services/shared/errors.js'
import { consumeAuthThrottle } from './auth-throttle-service.js'

/** What a step answers when its counter cannot be consumed or is spent. */
export interface ThrottleAnswers {
    /** Public message of the 500 (503 when Redis is unreachable) of a failed consume: fail closed. */
    unavailable: string
    /** The error of a spent counter. */
    rejected: AppError
}

/**
 * Consumes one attempt of `policy` for `key` and turns the outcome into a result: `ok` while the
 * counter allows it, `answers.rejected` once it is spent, and, when Redis does not answer, an
 * internal error (503 for an outage) carrying `answers.unavailable`. The caller stops on an
 * error and does nothing else on its behalf: no lookup, no mail, no write.
 */
export async function enforceThrottle(
    policy: ThrottlePolicy,
    key: string,
    answers: ThrottleAnswers,
): Promise<AppResult<void>> {
    const consumed = await tryInternal(() => consumeAuthThrottle(policy, key), answers.unavailable)
    if (Result.isError(consumed)) return Result.err(consumed.error)
    if (!consumed.value.allowed) return Result.err(answers.rejected)
    return Result.ok(undefined)
}
