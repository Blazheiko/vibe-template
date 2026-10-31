import type { SessionInfo } from '#vendor/types/types.js'

// ADR 0002: a session in Redis only proves it was issued, not that it is still
// valid. Revocation (password change, password reset, logout-all) rotates
// users.sessionToken in the database, and every authenticated request and
// WebSocket message compares the session's userToken with it. That makes
// revocation independent of whether the Redis cleanup (destroyAllSessions) finished.
//
// The vendor layer holds no repositories: the app registers the lookup at startup,
// the same way it registers the WebSocket hooks.

export type SessionTokenStatus = 'ok' | 'mismatch' | 'unavailable'

/**
 * `mismatch`: the user is gone or their sessionToken was rotated.
 * `unavailable`: the lookup itself failed (database down, timeout).
 */
export type SessionTokenChecker = (userId: string, userToken: string) => Promise<SessionTokenStatus>

let checker: SessionTokenChecker | null = null

export const registerSessionTokenChecker = (fn: SessionTokenChecker): void => {
    checker = fn
}

const getChecker = (): SessionTokenChecker => {
    if (checker === null) {
        throw new Error(
            'Session token checker not registered. Call registerSessionTokenChecker() before starting the server.',
        )
    }
    return checker
}

const signedInUserId = (sessionInfo: SessionInfo): string | null => {
    const { userId } = sessionInfo.data
    return typeof userId === 'string' && userId !== '' ? userId : null
}

/**
 * Compares the session's userToken with the user's current sessionToken. Anonymous
 * sessions have no user and pass without a lookup. Fail-closed: a lookup that cannot
 * answer is `unavailable`, never `ok`.
 */
export const assertSessionTokenCurrent = async (
    sessionInfo: SessionInfo,
    userToken: string,
): Promise<SessionTokenStatus> => {
    const userId = signedInUserId(sessionInfo)
    if (userId === null) return 'ok'
    return await getChecker()(userId, userToken)
}
