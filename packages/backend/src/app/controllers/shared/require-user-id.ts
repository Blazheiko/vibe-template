import type { HttpContext } from '#vendor/types/types.js'
import { parseUserId, type UserId } from '#app/domain/ids.js'

/**
 * The id of the signed-in user, or `null` when nobody is signed in (no session, an anonymous one,
 * or one without a usable user id). Sets nothing on the response: the caller answers 401 with
 * `mapControllerError(context, unauthorized())`. The session keeps the id as text; it becomes a
 * UserId here (feat-263, ADR 0007 Р13), and text that is not a row id is no user.
 */
export function requireUserId(context: Pick<HttpContext, 'auth'>): UserId | null {
    if (!context.auth.check()) return null
    return parseUserId(context.auth.getUserId())
}
