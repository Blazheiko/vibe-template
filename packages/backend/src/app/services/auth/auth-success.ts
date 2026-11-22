import { getSessionCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { generateWsToken } from '#app/services/auth/generate-ws-token-service.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import { userTransformer } from '#app/transformers/index.js'
import type { Session } from '#vendor/types/types.js'

// feat-245: the answer of every sign-in (password, OAuth link, second step), in its own module so
// the second-step service and the auth service both use it without importing each other.

export interface AuthSuccessPayload {
    status: 'success'
    user: ReturnType<typeof userTransformer.serialize>
    wsUrl: string
    wsToken: string
    csrfToken?: string
}

/**
 * The answer of a sign-in once the request's session is the signed-in one: the user, the WebSocket
 * token of that session and its CSRF token. feat-245: the second step answers the same.
 */
export async function authSuccessPayload(
    user: Parameters<typeof userTransformer.serialize>[0],
    session: Session,
): Promise<AuthSuccessPayload> {
    const sessionInfo = session.sessionInfo
    let wsToken = ''
    if (sessionInfo !== null) {
        const wsTokenResult = await generateWsToken(sessionInfo, String(user.id))

        wsToken = wsTokenResult
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
    return payload
}
