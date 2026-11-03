import { Result } from 'better-result'
import { throttlePolicies, type ThrottlePolicy } from '#config/throttle-policies.js'
import type { AppError, AppResult } from '#app/services/shared/errors.js'
import { consumeAuthThrottle } from './auth-throttle-service.js'

/**
 * Consumes one attempt of `policy` for `key`: `ok` while the counter allows it, `rejected` once
 * it is spent. When Redis does not answer the consume throws (ADR 0004) and the transport
 * answers 503: fail closed. The caller stops on an error and does nothing else on its behalf:
 * no lookup, no mail, no write.
 */
export async function enforceThrottle(
    policy: ThrottlePolicy,
    key: string,
    rejected: AppError,
): Promise<AppResult<void>> {
    const consumed = await consumeAuthThrottle(policy, key)
    return consumed.allowed ? Result.ok(undefined) : Result.err(rejected)
}

/**
 * The three budgets of a mail that confirms an address for an account: per address, per
 * account, and the per-account cooldown (feat-098). Every path that issues such a link
 * consumes them before the token and the mail: linking an address from the account page,
 * the mailed OAuth link to an existing account, and the first address of a new OAuth
 * account with its resend. They stop repeated mail to one mailbox and the cancelling of
 * its pending links over and over.
 */
export async function enforceEmailLinkThrottles(
    email: string,
    userId: bigint,
    rejected: AppError,
): Promise<AppResult<void>> {
    const budgets: [ThrottlePolicy, string][] = [
        [throttlePolicies.linkEmailTarget, email],
        [throttlePolicies.linkEmailUser, String(userId)],
        [throttlePolicies.linkEmailUserCooldown, String(userId)],
    ]
    for (const [policy, key] of budgets) {
        const consumed = await enforceThrottle(policy, key, rejected)
        if (Result.isError(consumed)) return consumed
    }
    return Result.ok(undefined)
}
