import type { SessionAuthState } from 'shared/mfa'

import { userEventBus } from '#app/services/communication/user-event-bus.js'
import { wsSessionAuthSync } from '#app/websocket/ws-session-auth-sync.js'
import logger from '#vendor/utils/logger.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): after a step-up raised the auth state of a
// session, its connections on this instance get the new state (and admin channel deadline) at
// once; the other instances get `session_auth_changed { sessionId }` and read the session from
// Redis (best effort: a lost signal leaves the connection on its old state until it reconnects).
// Never throws.
// Registered with the session layer at start (onSessionAuthRaised).
export const announceSessionAuthChanged = (
    userId: string,
    sessionId: string,
    auth: SessionAuthState | undefined,
): void => {
    try {
        wsSessionAuthSync.apply(userId, sessionId, auth)
    } catch (err) {
        logger.error({ err, userId }, 'WS session auth not applied after step-up')
    }
    void userEventBus.notifyOtherInstances(userId, 'session_auth_changed', { sessionId })
}
