import { Result } from 'better-result'
import type { ThrottlePolicy } from '#config/throttle-policies.js'
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
