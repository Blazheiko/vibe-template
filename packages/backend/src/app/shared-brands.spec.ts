import { type } from '@arktype/type'
import { EntityIdSchema, type EntityId } from 'shared'
import { describe, expect, it } from 'vitest'

import {
    asUserId,
    parseOAuthAccountId,
    parseSmsChallengeId,
    parseUserId,
    toEntityId,
    type NotificationId,
    type OAuthAccountId,
    type PasskeyId,
    type PushSubscriptionId,
    type SmsChallengeId,
    type UserId,
} from '#app/domain/ids.js'
import {
    oauthAccountRepository,
    pushSubscriptionRepository,
    webauthnCredentialRepository,
} from '#app/repositories/index.js'
import { uid } from '../test-support/ids.js'

// EntityId is branded (code-issues item 58): typecheck rejects a plain string,
// a value is an EntityId only after EntityIdSchema accepted it.
const takesId = (id: EntityId): string => id

describe('EntityId brand', () => {
    // feat-272: only a branded row id becomes an EntityId; a bare bigint may be no row id at all.
    it('toEntityId takes a row id, not any bigint', () => {
        const typeCases = (): unknown[] => [
            toEntityId(uid(7)),
            // @ts-expect-error 0n is no row id (the shared validator refuses '0')
            toEntityId(0n),
            // @ts-expect-error nor is a negative one
            toEntityId(-1n),
            // @ts-expect-error nor one past the bigint column
            toEntityId(2n ** 63n),
        ]
        expect(typeof typeCases).toBe('function')
        expect(toEntityId(uid(7))).toBe('7')
    })

    it('is produced by the schema', () => {
        const parsed = EntityIdSchema('42')
        if (parsed instanceof type.errors) throw new Error(parsed.summary)
        expect(takesId(parsed)).toBe('42')
    })

    it('is not assignable from a plain string', () => {
        // @ts-expect-error a plain string is not an EntityId
        const id: EntityId = '42'
        expect(id).toBe('42')
    })
})

// feat-263 (ADR 0007): ids of two tables do not mix up, and outside text is branded only by a
// constructor. The calls are never awaited; the file is checked by the compiler.
describe('row id brands', () => {
    it('refuses swapped ids of different tables', () => {
        const userId = uid(5)
        const linkId = 31n as OAuthAccountId
        const passkeyId = 9n as PasskeyId
        const subscriptionId = 4n as PushSubscriptionId
        const notificationId = 4n as NotificationId
        const unlink = () => [
            oauthAccountRepository.deleteForUser(userId, linkId, {} as never),
            // @ts-expect-error a link id is not a user id (Р11: the owner comes first)
            oauthAccountRepository.deleteForUser(linkId, userId, {} as never),
            webauthnCredentialRepository.rename(userId, passkeyId, 'Key'),
            // @ts-expect-error a passkey id is not a user id
            webauthnCredentialRepository.rename(passkeyId, userId, 'Key'),
            pushSubscriptionRepository.delete(userId, subscriptionId),
            // @ts-expect-error a subscription id is not a user id (feat-264, Р11)
            pushSubscriptionRepository.delete(subscriptionId, userId),
            // @ts-expect-error a notification id is not a subscription id
            pushSubscriptionRepository.findById(notificationId),
        ]
        expect(typeof unlink).toBe('function')
    })

    it('refuses a plain bigint or string where a branded id is expected', () => {
        // @ts-expect-error a bigint is not a UserId before parseUserId
        const id: UserId = 5n
        // @ts-expect-error a string is not an SMS challenge id before parseSmsChallengeId
        const challenge: SmsChallengeId = 'abc'
        expect([id, challenge]).toHaveLength(2)
    })

    it('brands text only through the constructors', () => {
        expect(parseUserId('42')).toBe(42n)
        expect(parseUserId('007')).toBeNull()
        expect(parseUserId(undefined)).toBeNull()
        expect(parseOAuthAccountId('9223372036854775808')).toBeNull()
        expect(parseSmsChallengeId('V1StGXR8_Z5jdHi6B-myT')).toBe('V1StGXR8_Z5jdHi6B-myT')
        expect(parseSmsChallengeId('x'.repeat(25))).toBeNull()
        expect(() => asUserId('abc')).toThrow('not a row id')
        expect(toEntityId(uid(42))).toBe('42')
    })
})
