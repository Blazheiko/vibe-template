import { createHash, randomBytes } from 'node:crypto'
import { seconds, type Seconds } from 'shared/brand'
import type { MfaTicketId } from '#app/domain/secrets.js'

import redis, { withRedis } from '#database/redis.js'
import { setWithTtlSeconds } from '#app/services/shared/redis-ttl.js'
import webauthnConfig from '#config/webauthn.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р5, Р6): the WebAuthn challenges that live outside a
// signed-in session. A passwordless sign-in keeps its challenge under a random id the browser
// sends back; the second sign-in step under the hash of its ticket (the ticket id itself never
// leaves its HttpOnly cookie). Five minutes at most; taken with GETDEL, so of two answers to one
// challenge only one is checked.

const LOGIN = 'auth:webauthn:login:'
const MFA = 'auth:webauthn:mfa:'
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

/** `mfa:<hash>` of Р5: the binding of a second-step challenge to its ticket. */
export const ticketHash = (ticketId: MfaTicketId): string =>
    createHash('sha256').update(ticketId).digest('base64url')

const ttlOf = (ttl?: Seconds): Seconds =>
    seconds(
        Math.max(
            1,
            Math.min(ttl ?? webauthnConfig.challengeTtlSeconds, webauthnConfig.challengeTtlSeconds),
        ),
    )

export const passkeyLoginChallenges = {
    async issue(challenge: string): Promise<string> {
        const id = randomBytes(16).toString('base64url')
        await withRedis(() => setWithTtlSeconds(redis, `${LOGIN}${id}`, challenge, ttlOf()))
        return id
    },

    /** The challenge of `id`, removed in the same step; null when gone, spent or not an id. */
    async take(id: string): Promise<string | null> {
        if (!ID_PATTERN.test(id)) return null
        return withRedis(() => redis.getdel(`${LOGIN}${id}`))
    },
}

export const passkeyTicketChallenges = {
    /** A new challenge for the ticket replaces an earlier one; it never outlives the ticket. */
    async issue(
        ticketId: MfaTicketId,
        challenge: string,
        ticketTtlSeconds: Seconds,
    ): Promise<void> {
        await withRedis(() =>
            setWithTtlSeconds(
                redis,
                `${MFA}${ticketHash(ticketId)}`,
                challenge,
                ttlOf(ticketTtlSeconds),
            ),
        )
    },

    async take(ticketId: MfaTicketId): Promise<string | null> {
        return withRedis(() => redis.getdel(`${MFA}${ticketHash(ticketId)}`))
    },

    /**
     * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 6): the challenge read without taking
     * it. The second step checks an answer against it, then the ticket's failure count or capture
     * spends it atomically, and only while it is still this value (mfa-ticket.ts): of two answers
     * to one challenge one is counted or wins, and a count lost with its answer is not repeated.
     */
    async peek(ticketId: MfaTicketId): Promise<string | null> {
        return withRedis(() => redis.get(`${MFA}${ticketHash(ticketId)}`))
    },

    /** The Redis key of the ticket's challenge (the client's key prefix is added by Redis). */
    keyOf(ticketId: MfaTicketId): string {
        return `${MFA}${ticketHash(ticketId)}`
    },
}
