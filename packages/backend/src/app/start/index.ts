// This file automatically imports all initialization files
// Add new initialization files here to execute them on startup

import { mfaCompletionIdOf } from '#app/domain/secrets.js'
import {
    registerWsAppHooks,
    registerWsMessageValidator,
} from '#vendor/utils/network/ws-handlers.js'
import { wsMessageValidator } from '#app/validate/ws-message-validator.js'
import { websocketCoordinator } from '#app/websocket/ws-coordinator.js'
import { wsSessionAuth } from '#app/websocket/ws-session-auth.js'
import { registerSessionTokenChecker } from '#vendor/utils/session/session-token-check.js'
import { registerSignInCompletionHook } from '#vendor/utils/session/request-session.js'
import { registerSessionDeletionLock } from '#vendor/utils/session/session-deletion-lock.js'
import { retireCompletedTicket } from '#app/services/auth/mfa/mfa-sign-in.js'
import { checkSessionTokenText } from '#app/services/auth/session-token-check.js'
import { sessionDeletionLock } from '#app/services/user/session-list-service.js'

registerWsMessageValidator(wsMessageValidator)

registerWsAppHooks({
    onUpgrade: (token) => wsSessionAuth.verifyUpgradeToken(token),
    onConnected: (ws, userData) => websocketCoordinator.handleConnected(ws, userData),
    onDisconnected: (ws, userData, code) =>
        websocketCoordinator.handleDisconnected(ws, userData, code),
})

// ADR 0002: sessions are revoked by rotating users.sessionToken; the vendor session
// layer compares it on every authenticated request and WebSocket message.
registerSessionTokenChecker(checkSessionTokenText)
// feat-245 (Р4): the browser came back with the session its second step created.
registerSignInCompletionHook((context, completionId) =>
    retireCompletedTicket(context.auth, mfaCompletionIdOf(completionId)),
)
// Р13: a logout, and a sign-in replacing a signed-in session, delete its record under the user's
// row lock, as ending a session from the session list does: a privileged write that checked the
// record under that lock commits first.
registerSessionDeletionLock(sessionDeletionLock)
