import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import { CURRENT_SESSION_REASON } from 'shared/errors'
import type { SessionView } from 'shared'

import { userRepository, withTransaction } from '#app/repositories/index.js'
import { withRole, type UserAuditActor } from '#app/services/audit/audit-actor.js'
import { auditService } from '#app/services/audit/audit-service.js'
import { sessionTransformer } from '#app/transformers/index.js'
import { retirePendingResets } from '#app/services/auth/phone-challenges.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import {
    badRequest,
    conflict,
    notFound,
    sessionRevoked,
    type AppResult,
} from '#app/services/shared/errors.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import type { SessionInfo } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import {
    destroyAllSessions,
    destroySession,
    findSessionByPublicId,
    listSessions,
} from '#vendor/utils/session/redis-session-storage.js'
import {
    decodeSessionCursor,
    encodeSessionCursor,
} from '#vendor/utils/session/session-page-cursor.js'
import { sessionListChanged } from '#vendor/utils/session/session-list-events.js'

// feat-233: the account page's list of active sessions (Р7), ending one of them (Р8) and ending
// all but the current one (Р9). The list lives in Redis next to the records (Р1, Р2); `online`
// comes from the WebSocket registry of this instance (Р13).

export interface SessionListPage {
    current: SessionView | null
    others: SessionView[]
    nextCursor: string | null
}

/** Whether the session that asks still has its record (feat-134): checked before a change. */
type SessionStillStored = () => Promise<boolean>

const onlineSessionIds = (userId: string): Set<string> =>
    new Set(wsConnectionRegistry.listUserConnections(userId).map((c) => c.sessionId))

export const sessionListService = {
    /**
     * The current session apart (first page only) and a page of the others after `cursor`, newest
     * first. `current` is the session that asks, as the request read it.
     */
    async list(input: {
        userId: string
        current: SessionInfo
        cursor: string | undefined
    }): Promise<AppResult<SessionListPage>> {
        const { userId, current } = input
        const userToken = current.data.userToken
        if (typeof userToken !== 'string') return Result.err(sessionRevoked())
        const after = input.cursor === undefined ? null : decodeSessionCursor(input.cursor)
        if (input.cursor !== undefined && after === null) {
            return Result.err(badRequest('Invalid cursor'))
        }

        const currentDevice = current.data.device
        const online = onlineSessionIds(userId)
        const page = await listSessions(userToken, {
            after,
            excludePublicId: currentDevice?.publicId,
        })

        let currentView: SessionView | null = null
        if (after === null && currentDevice !== undefined) {
            const meta = await findSessionByPublicId(userToken, currentDevice.publicId)
            currentView = sessionTransformer.serialize({
                device: currentDevice,
                lastSeenAtMs: meta?.seen ?? null,
                current: true,
                online: online.has(current.id),
            })
        }

        const others: SessionView[] = []
        for (const session of page.sessions) {
            const device = session.info.data.device
            if (device === undefined) continue
            others.push(
                sessionTransformer.serialize({
                    device,
                    lastSeenAtMs: session.lastSeenAtMs,
                    current: false,
                    online: online.has(session.sessionId),
                }),
            )
        }

        return Result.ok({
            current: currentView,
            others,
            nextCursor: page.next === null ? null : encodeSessionCursor(page.next),
        })
    },

    /**
     * Ends one other session (Р8), as a logout of it would: its record goes, its sockets on this
     * instance close at once, those on other instances at the next re-check. No token rotation.
     * An unknown id, an id of another user and an already ended session are all 404.
     */
    async revoke(input: {
        userId: string
        current: SessionInfo
        publicId: string
        sessionStored: SessionStillStored
    }): Promise<AppResult<void>> {
        const { userId, current, publicId } = input
        const userToken = current.data.userToken
        if (typeof userToken !== 'string') return Result.err(sessionRevoked())
        if (current.data.device?.publicId === publicId) {
            return Result.err(
                conflict('The current session ends with a logout', CURRENT_SESSION_REASON),
            )
        }
        if (!(await input.sessionStored())) return Result.err(sessionRevoked())

        const target = await findSessionByPublicId(userToken, publicId)
        if (target === null) return Result.err(notFound('Session', 'Session not found'))
        const removed = await destroySession(target.sid, userToken, publicId)
        if (!removed) return Result.err(notFound('Session', 'Session not found'))

        wsSessionRevocation.closeUserConnections(userId, { sessionId: target.sid })
        userNotificationService.security(BigInt(userId), 'session_revoked')
        sessionListChanged(userId)
        logger.info({ userId, sessionId: target.sid }, 'Session ended from the session list')
        return Result.ok(undefined)
    },

    /**
     * Ends every session but the one that asks (Р9): the path of a password change, without the
     * password. The rotation of users.session_token is the revocation (ADR 0002) and happens only
     * while the presented token is current (feat-096); the pending resets go in its transaction.
     * Answers the rotated token: the controller renews the session under it.
     */
    async revokeOthers(input: {
        userId: bigint
        presentedSessionToken: string | undefined
        requestingSessionId: string | undefined
        sessionStored: SessionStillStored
        /** feat-235: who ends them: the signed-in user of the request. */
        actor: UserAuditActor
    }): Promise<AppResult<{ sessionToken: string }>> {
        const { userId, presentedSessionToken: presented } = input
        const { actor } = input
        if (presented === undefined) return Result.err(sessionRevoked())
        if (!(await input.sessionStored())) return Result.err(sessionRevoked())

        const rotatedSessionToken = nanoid()
        const rotated = await withTransaction(async (tx) => {
            const done = await userRepository.updateIfSessionToken(
                userId,
                presented,
                { sessionToken: rotatedSessionToken },
                tx,
            )
            if (done === undefined) return undefined
            await retirePendingResets(done, tx)
            // feat-235: the event commits with the rotation; a failed insert leaves the previous
            // token valid.
            const stamp = await auditService.stamp(tx)
            return auditService.record(tx, stamp, withRole(actor, done.role), [
                {
                    action: 'auth.sessions.revoked_others',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: {},
                },
            ])
        })
        if (rotated === undefined) {
            const currentToken = await userRepository.findSessionToken(userId)
            return Result.err(
                currentToken === undefined ? notFound('User', 'User not found') : sessionRevoked(),
            )
        }
        auditService.logCommitted(actor.logger, rotated)

        // feat-221: the sockets of the session that asks stay; the controller renews it and the
        // client replaces its socket. Without a renewal the controller closes them.
        wsSessionRevocation.closeUserConnections(
            String(userId),
            input.requestingSessionId === undefined
                ? {}
                : { exceptSessionId: input.requestingSessionId },
        )

        // Memory cleanup, not the revocation: every record left is already rejected.
        try {
            const cleanup = await destroyAllSessions(presented)
            if (!cleanup.complete) {
                logger.warn(
                    { userId: String(userId), deleted: cleanup.deleted },
                    'End other sessions: not every session record was deleted; they are revoked',
                )
            }
        } catch (err: unknown) {
            logger.warn(
                { err, userId: String(userId) },
                'End other sessions: the session records were not deleted',
            )
        }

        userNotificationService.security(userId, 'logout_all')
        sessionListChanged(String(userId))
        return Result.ok({ sessionToken: rotatedSessionToken })
    },
}
