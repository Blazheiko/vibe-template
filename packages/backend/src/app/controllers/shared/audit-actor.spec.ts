import { describe, expect, it, vi } from 'vitest'

import { auditActorFrom, proofHolderActor, rememberActorRole, systemActor } from './audit-actor.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р6): the controllers build the actor of an audited change from the request.

const requestLogger = { info: vi.fn() }
const contextOf = (userId: string | null) =>
    ({
        auth: { getUserId: () => userId },
        requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        logger: requestLogger,
    }) as never

describe('audit actors', () => {
    it('a signed-in request is a user actor with its id, request id and logger', () => {
        expect(auditActorFrom(contextOf('42'))).toEqual({
            kind: 'user',
            userId: 42n,
            role: null,
            requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            proof: null,
            source: null,
            logger: requestLogger,
        })
        expect(auditActorFrom(contextOf('42'), 'user').role).toBe('user')
    })

    it('takes the role admin_guard read for the same request', () => {
        const context = contextOf('7')
        rememberActorRole(context, 'admin')
        expect(auditActorFrom(context).role).toBe('admin')
        // Another request knows nothing of it.
        expect(auditActorFrom(contextOf('7')).role).toBeNull()
    })

    it('refuses to build a user actor without a signed-in user', () => {
        expect(() => auditActorFrom(contextOf(null))).toThrow()
    })

    it('a proof holder has no user id and carries its proof', () => {
        expect(proofHolderActor(contextOf(null), 'email_link')).toEqual({
            kind: 'proof_holder',
            userId: null,
            role: null,
            requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            proof: 'email_link',
            source: null,
            logger: requestLogger,
        })
    })

    it('the system has no request and names its source', () => {
        const actor = systemActor('seed')
        expect(actor).toMatchObject({
            kind: 'system',
            userId: null,
            role: null,
            requestId: null,
            proof: null,
            source: 'seed',
        })
    })
})
