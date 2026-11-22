import { randomBytes } from 'node:crypto'

import redis, { withRedis } from '#database/redis.js'
import webauthnConfig from '#config/webauthn.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р5, Р6): the challenges of a passwordless sign-in.
// Nobody is signed in yet, so they live in Redis under a random id the browser sends back, for
// five minutes, and are taken with GETDEL: of two answers to one challenge only one is checked.

const PREFIX = 'auth:webauthn:login:'
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export const passkeyLoginChallenges = {
    async issue(challenge: string): Promise<string> {
        const id = randomBytes(16).toString('base64url')
        await withRedis(() =>
            redis.set(`${PREFIX}${id}`, challenge, 'EX', webauthnConfig.challengeTtlSeconds),
        )
        return id
    },

    /** The challenge of `id`, removed in the same step; null when gone, spent or not an id. */
    async take(id: string): Promise<string | null> {
        if (!ID_PATTERN.test(id)) return null
        return withRedis(() => redis.getdel(`${PREFIX}${id}`))
    },
}
