import type { HttpContext } from '#vendor/types/types.js'

/**
 * The id of the signed-in user, or `null` when nobody is signed in (no session, an anonymous one,
 * or one without a usable user id). Sets nothing on the response: the caller answers 401 with
 * `mapControllerError(context, unauthorized())`.
 */
export function requireUserId(context: Pick<HttpContext, 'auth'>): bigint | null {
    if (!context.auth.check()) return null

    const userId = context.auth.getUserId()
    return userId === null ? null : BigInt(userId)
}
