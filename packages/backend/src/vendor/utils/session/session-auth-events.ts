import type { SessionAuthState } from 'shared/mfa'

import logger from '#vendor/utils/logger.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the session layer says when the auth state of a
// session rose (a step-up). The app decides what follows (the WebSocket connections of the
// session get the new state, on every instance); the session layer imports nothing of the app.

type Listener = (userId: string, sessionId: string, auth: SessionAuthState | undefined) => void

let listener: Listener | null = null

export const onSessionAuthRaised = (next: Listener | null): void => {
    listener = next
}

/** Best effort: a failing listener never fails the step-up that raised the state. */
export const sessionAuthRaised = (
    userId: string,
    sessionId: string,
    auth: SessionAuthState | undefined,
): void => {
    try {
        listener?.(userId, sessionId, auth)
    } catch (err) {
        logger.warn({ err, userId }, 'Session auth change not announced')
    }
}
