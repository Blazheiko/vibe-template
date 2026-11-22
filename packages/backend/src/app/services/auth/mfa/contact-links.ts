import {
    emailLinkVerificationRepository,
    smsAuthChallengeRepository,
    type DbExecutor,
} from '#app/repositories/index.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, row 7 of Р3): linking a phone or an email is allowed
// by a fresh proof at its start and finished by the SMS code or the mailed link. A change of the
// account's MFA (a factor turned on, off or replaced, a reset) ends every such link still pending,
// in the transaction of that change, so a link allowed under the old protection cannot finish
// under the new one, as a password change retires the reset links.
export async function retirePendingContactLinks(userId: bigint, tx: DbExecutor): Promise<void> {
    await smsAuthChallengeRepository.invalidatePendingLinksOfUser(userId, tx)
    await emailLinkVerificationRepository.invalidatePendingByUserId(userId, tx)
}
