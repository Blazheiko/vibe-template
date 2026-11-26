import type { Brand } from 'shared/brand'

// Branded ids of the rows (feat-263, ADR 0007): one brand per table, so ids of two different
// tables do not mix up at compile time. Declarations only: database/schema.ts puts them on the
// columns with `.$type<…>()` (a relative type import, since drizzle-kit loads the schema without
// the # aliases), and app/domain/ids.ts has their constructors. A brand is added in the same
// feature as the signatures of its domain: a branded column refuses a plain bigint in eq().

export type UserId = Brand<bigint, 'UserId'>
export type OAuthAccountId = Brand<bigint, 'OAuthAccountId'>
export type UserOnlineId = Brand<bigint, 'UserOnlineId'>
/**
 * The id of a row of any of the four one-time token tables (email verifications, email link
 * verifications, password resets, OAuth link verifications): one brand for all four, since the
 * ids never leave one-time-token.ts and the token repository is shared (plan Р3).
 */
export type OneTimeTokenRowId = Brand<bigint, 'OneTimeTokenRowId'>
export type TotpFactorId = Brand<bigint, 'TotpFactorId'>
export type MfaRecoveryCodeId = Brand<bigint, 'MfaRecoveryCodeId'>
export type PasskeyId = Brand<bigint, 'PasskeyId'>
/** sms_auth_challenges.id is a nanoid of 24 characters, not a bigserial. */
export type SmsChallengeId = Brand<string, 'SmsChallengeId'>
