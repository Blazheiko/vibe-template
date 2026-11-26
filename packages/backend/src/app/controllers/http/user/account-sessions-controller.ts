import { Result } from 'better-result'
import { presentedSessionTokenOf } from '#app/domain/secrets.js'
import { toEntityId } from '#app/domain/ids.js'
import type { ListSessionsQuery } from 'shared/schemas'
import type {
    ListSessionsResponse,
    RevokeOtherSessionsResponse,
    RevokeSessionResponse,
} from 'shared/responses'

import type { HttpContext } from '#vendor/types/types.js'
import { isSessionPublicId } from '#vendor/utils/session/session-public-id.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { authService } from '#app/services/auth/auth-service.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import { notFound, sessionRevoked, unauthorized } from '#app/services/shared/errors.js'
import { sessionListService } from '#app/services/user/session-list-service.js'

// feat-233: the account page's active sessions (Р7–Р9).
export default {
    async listSessions(
        context: HttpContext<unknown, ListSessionsQuery>,
    ): Promise<ListSessionsResponse> {
        const userId = requireUserId(context)
        const current = context.session.sessionInfo
        if (userId === null || current === null) {
            return mapControllerError(context, unauthorized())
        }
        const result = await sessionListService.list({
            userId: String(userId),
            current,
            cursor: context.httpData.query.cursor,
        })
        return respond(context, result, (page) => ({ status: 'success', ...page }))
    },

    async revokeSession(
        context: HttpContext<unknown, null, { id: string }>,
    ): Promise<RevokeSessionResponse> {
        const userId = requireUserId(context)
        const current = context.session.sessionInfo
        if (userId === null || current === null) {
            return mapControllerError(context, unauthorized())
        }
        const publicId = context.httpData.params.id
        // Not one this server gives out: the same answer as an unknown one.
        if (!isSessionPublicId(publicId)) {
            return mapControllerError(context, notFound('Session', 'Session not found'))
        }
        const result = await sessionListService.revoke({
            userId,
            current,
            publicId,
            sessionStored: () => context.session.isStored(),
        })
        return respond(context, result, () => ({ status: 'success' as const }))
    },

    async revokeOtherSessions(context: HttpContext): Promise<RevokeOtherSessionsResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }
        // Before the renewal replaces it: the connections kept open were opened from this id.
        const sessionId = context.session.sessionInfo?.id
        if (sessionId === undefined) return mapControllerError(context, sessionRevoked())
        const result = await sessionListService.revokeOthers({
            userId,
            presentedSessionToken: presentedSessionTokenOf(context.auth.getPresentedUserToken()),
            requestingSessionId: sessionId,
            sessionStored: () => context.session.isStored(),
            actor: auditActorFrom(context),
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        // The other sessions are ended already: a failed renewal does not undo that, so the answer
        // stays a success and says this session was not renewed (as after a password change).
        const renewed = await authService
            .renewSession(context.auth, context.session, result.value.sessionToken)
            .catch((err: unknown) => Result.err(err))
        if (Result.isError(renewed)) {
            context.logger.error(
                { err: renewed.error },
                'Session renewal after ending the other sessions failed',
            )
            wsSessionRevocation.closeUserConnections(toEntityId(userId), { sessionId })
            return { status: 'success', sessionRenewed: false }
        }
        return { status: 'success', sessionRenewed: true, ...renewed.value }
    },
}
