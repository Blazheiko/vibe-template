import { getSessionCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { asIsoDateTime } from '#app/domain/wire.js'
import type { IsoDateTime } from 'shared/brand'
import { toEntityId } from '#app/domain/ids.js'
import { generateWsToken } from '#app/services/auth/generate-ws-token-service.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import { userTransformer } from '#app/transformers/index.js'
import type { Session } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'

// feat-245: the answer of every sign-in (password, OAuth link, second step), in its own module so
// the second-step service and the auth service both use it without importing each other.

export interface AuthSuccessPayload {
    status: 'success'
    user: ReturnType<typeof userTransformer.serialize>
    wsUrl: string
    wsToken: string
    csrfToken?: string
    /** feat-245 (Р8): set when the request's session is a recovery session (as main/init says). */
    recovery?: { expiresAt: IsoDateTime; replaced: boolean }
}

/**
 * The answer of a sign-in once the request's session is the signed-in one: the user, the WebSocket
 * token of that session and its CSRF token. feat-245: the second step answers the same, with the
 * recovery state of a recovery session.
 */
export async function authSuccessPayload(
    user: Parameters<typeof userTransformer.serialize>[0],
    session: Session,
    /**
     * feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 7): `optional` for an answer built after
     * the session cookie was issued (the MFA activation): a token that cannot be issued is left
     * empty, main/init brings it. Every other sign-in keeps a failure a failure.
     */
    options: { wsToken?: 'required' | 'optional' } = {},
): Promise<AuthSuccessPayload> {
    const sessionInfo = session.sessionInfo
    let wsToken = ''
    if (sessionInfo !== null) {
        try {
            wsToken = await generateWsToken(sessionInfo, toEntityId(user.id))
        } catch (err) {
            if (options.wsToken !== 'optional') throw err
            logger.warn({ err, userId: String(user.id) }, 'WebSocket token not issued; main/init')
        }
    }

    const csrfToken = getSessionCsrfToken(sessionInfo)
    const payload: AuthSuccessPayload = {
        status: 'success',
        user: userTransformer.serialize(user),
        wsUrl: wsToken !== '' ? getWsUrl() : '',
        wsToken,
    }
    if (csrfToken !== undefined) {
        payload.csrfToken = csrfToken
    }
    // A recovery code (or a `continue` that finished one) created a recovery session: the client
    // must show only the recovery wizard before main/init answers.
    const recovery = sessionInfo?.data.auth?.recovery
    if (recovery !== undefined) {
        payload.recovery = {
            expiresAt: asIsoDateTime(recovery.expiresAt),
            replaced: recovery.replacementFactor !== undefined,
        }
    }
    return payload
}
