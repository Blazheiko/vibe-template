// Constructors of the branded row ids (feat-263, ADR 0007, plan Р4). Ids from outside (a path,
// a query, a session) become branded only here, after isValidEntityId; a row read from the
// database is branded by its column type already. One constructor per brand: a generic
// parseId<B> would let the caller pick the brand, which is the same unchecked cast.
//
// No # imports in app/domain (plan Р3, Р10): database/schema.ts may import these modules with a
// relative path, and drizzle-kit loads the schema without the aliases.

import { isValidEntityId, type EntityId } from 'shared/brand'

import type {
    AuditEventId,
    LlmSystemPromptId,
    LlmTextUsageId,
    MfaRecoveryCodeId,
    OneTimeTokenRowId,
    PushNotificationLogId,
    NotificationId,
    OAuthAccountId,
    PasskeyId,
    PushSubscriptionId,
    SupportArticleId,
    SupportMessageId,
    SmsChallengeId,
    TotpFactorId,
    UserId,
    UserOnlineId,
} from '../../database/ids.js'

export type {
    AuditEventId,
    LlmSystemPromptId,
    LlmTextUsageId,
    MfaRecoveryCodeId,
    NotificationId,
    OAuthAccountId,
    OneTimeTokenRowId,
    PasskeyId,
    PushNotificationLogId,
    PushSubscriptionId,
    SmsChallengeId,
    SupportArticleId,
    SupportMessageId,
    TotpFactorId,
    UserId,
    UserOnlineId,
} from '../../database/ids.js'

const parse = (raw: string | null | undefined): bigint | null =>
    typeof raw === 'string' && isValidEntityId(raw) ? BigInt(raw) : null

/** The id of a user from its decimal text, or null when the text is not a row id. */
export const parseUserId = (raw: string | null | undefined): UserId | null =>
    parse(raw) as UserId | null

/**
 * The id of a user from text the app wrote itself and already checked: the user id of a signed-in
 * session (`auth.getUserId()` returns only a row id), of a WS connection or of an MFA ticket.
 * Text that is not a row id there means corrupted state, so it throws instead of guessing.
 */
export const asUserId = (raw: string): UserId => {
    const id = parseUserId(raw)
    if (id === null) throw new Error('asUserId: not a row id')
    return id
}

/** The id of an OAuth link from its decimal text, or null when the text is not a row id. */
export const parseOAuthAccountId = (raw: string | null | undefined): OAuthAccountId | null =>
    parse(raw) as OAuthAccountId | null

/** The id of a passkey from its decimal text (a path parameter), or null. */
export const parsePasskeyId = (raw: string | null | undefined): PasskeyId | null =>
    parse(raw) as PasskeyId | null

/** The id of a TOTP factor from its decimal text, or null. */
export const parseTotpFactorId = (raw: string | null | undefined): TotpFactorId | null =>
    parse(raw) as TotpFactorId | null

/** The id of a row of the online history (a cursor), or null. */
export const parseUserOnlineId = (raw: string | null | undefined): UserOnlineId | null =>
    parse(raw) as UserOnlineId | null

/** The id of a push subscription from its decimal text (a path parameter), or null. */
export const parsePushSubscriptionId = (
    raw: string | null | undefined,
): PushSubscriptionId | null => parse(raw) as PushSubscriptionId | null

/** The id of a notification from its decimal text (a path, a cursor, `upTo`), or null. */
export const parseNotificationId = (raw: string | null | undefined): NotificationId | null =>
    parse(raw) as NotificationId | null

/** The id of a knowledge-base article from its decimal text, or null. */
export const parseSupportArticleId = (raw: string | null | undefined): SupportArticleId | null =>
    parse(raw) as SupportArticleId | null

/** The id of a support chat message from its decimal text (the `before` cursor), or null. */
export const parseSupportMessageId = (raw: string | null | undefined): SupportMessageId | null =>
    parse(raw) as SupportMessageId | null

/**
 * The id of a support chat message from text a schema has already checked (the `before` cursor of
 * SupportChatHistoryQuerySchema); throws on anything else.
 */
export const asSupportMessageId = (raw: string): SupportMessageId => {
    const id = parseSupportMessageId(raw)
    if (id === null) throw new Error('asSupportMessageId: not a row id')
    return id
}

/**
 * The id of an article as a raw SQL result gives it (pg returns a bigint column as text): read from
 * the database, so anything that is not a row id throws.
 */
export const asSupportArticleId = (raw: bigint | string): SupportArticleId => {
    const id = parseSupportArticleId(String(raw))
    if (id === null) throw new Error('asSupportArticleId: not a row id')
    return id
}

/** The id of a system prompt from its decimal text, or null. */
export const parseLlmSystemPromptId = (raw: string | null | undefined): LlmSystemPromptId | null =>
    parse(raw) as LlmSystemPromptId | null

/** The id of an audit event read from a cursor, or null. */
export const parseAuditEventId = (raw: string | null | undefined): AuditEventId | null =>
    parse(raw) as AuditEventId | null

/**
 * The id of an SMS challenge as a client sends it back, or null. The ids are nanoids of up to 24
 * characters (sms_auth_challenges.id is varchar(24)): any other text names no challenge.
 */
export const parseSmsChallengeId = (raw: string | null | undefined): SmsChallengeId | null =>
    typeof raw === 'string' && /^[\w-]{1,24}$/.test(raw) ? (raw as SmsChallengeId) : null

/**
 * The id of any table row (feat-272): the bigint brands of database/ids.ts. A bare bigint (0n,
 * -1n, 2n ** 63n) is none, so `toEntityId` cannot make an EntityId the shared validator refuses.
 */
export type RowId =
    | AuditEventId
    | LlmSystemPromptId
    | LlmTextUsageId
    | MfaRecoveryCodeId
    | NotificationId
    | OAuthAccountId
    | OneTimeTokenRowId
    | PasskeyId
    | PushNotificationLogId
    | PushSubscriptionId
    | SupportArticleId
    | SupportMessageId
    | TotpFactorId
    | UserId
    | UserOnlineId

/** The decimal text of a row id, as it goes into a response, a session or a WS payload. */
export const toEntityId = (id: RowId): EntityId => String(id) as EntityId
