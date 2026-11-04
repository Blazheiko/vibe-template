import { smsAuthChallengeRepository } from '#app/repositories/index.js'
import type { DbTransaction } from '#app/repositories/transaction.js'
import { LINK_PHONE_FLOW, RESET_PHONE_FLOW } from '#app/services/auth/auth-normalize.js'

/**
 * Retires the pending SMS challenges of a phone (reset and link), in `executor`'s transaction
 * when given. Used by every flow that ends what was asked for the account before it: a claim, an
 * email reset, and (feat-121, M4) change-password and logout-all.
 */
export async function invalidatePendingPhoneChallenges(
    phone: string,
    executor?: DbTransaction,
): Promise<void> {
    // One after the other: inside a transaction both statements share one connection.
    await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(
        phone,
        RESET_PHONE_FLOW,
        executor,
    )
    await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, LINK_PHONE_FLOW, executor)
}
