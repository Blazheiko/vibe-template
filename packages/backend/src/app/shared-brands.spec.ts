import { type } from '@arktype/type'
import { EntityIdSchema, type EntityId } from 'shared'
import { describe, expect, it } from 'vitest'

import {
    asUserId,
    parseOAuthAccountId,
    parseSmsChallengeId,
    parseUserId,
    toEntityId,
    type OAuthAccountId,
    type PasskeyId,
    type SmsChallengeId,
    type UserId,
} from '#app/domain/ids.js'
import { oauthAccountRepository, webauthnCredentialRepository } from '#app/repositories/index.js'
import { uid } from '../test-support/ids.js'

// EntityId is branded (code-issues item 58): typecheck rejects a plain string,
// a value is an EntityId only after EntityIdSchema accepted it.
const takesId = (id: EntityId): string => id

describe('EntityId brand', () => {
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
        const unlink = () => [
            oauthAccountRepository.deleteForUser(userId, linkId, {} as never),
            // @ts-expect-error a link id is not a user id (Р11: the owner comes first)
            oauthAccountRepository.deleteForUser(linkId, userId, {} as never),
            webauthnCredentialRepository.rename(userId, passkeyId, 'Key'),
            // @ts-expect-error a passkey id is not a user id
            webauthnCredentialRepository.rename(passkeyId, userId, 'Key'),
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
