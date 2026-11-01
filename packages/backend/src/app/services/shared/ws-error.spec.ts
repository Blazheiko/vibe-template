import { describe, expect, it } from 'vitest'
import { appErrorToWsError } from './ws-error.js'
import { badRequest, conflict, forbidden, internal, notFound, unauthorized } from './errors.js'

const APP_ERROR_CASES = [
    { error: badRequest('Bad', 'bad_input'), status: 400 },
    { error: unauthorized(), status: 401 },
    { error: forbidden('Denied', 'not_allowed'), status: 403 },
    { error: notFound('User', 'Missing'), status: 404 },
    { error: conflict('Already', 'duplicate'), status: 409 },
    { error: internal(new Error('boom'), 'Hidden'), status: 500 },
] as const

type AppErrorCase = (typeof APP_ERROR_CASES)[number]

describe('ws-error', () => {
    it.each(APP_ERROR_CASES)('serializes %s for websocket clients', ({ error }: AppErrorCase) => {
        const wsPayload = appErrorToWsError(error)

        expect(wsPayload).toEqual({
            status: 'error',
            message: error._tag === 'Internal' ? error.publicMessage : error.message,
            code:
                error._tag === 'BadRequest'
                    ? 'bad_request'
                    : error._tag === 'Unauthorized'
                      ? 'unauthorized'
                      : error._tag === 'Forbidden'
                        ? 'forbidden'
                        : error._tag === 'NotFound'
                          ? 'not_found'
                          : error._tag === 'Conflict'
                            ? 'conflict'
                            : 'internal_error',
            ...('reason' in error ? { reason: error.reason } : {}),
        })

        if ('reason' in error) {
            expect(wsPayload.reason).toBe(error.reason)
        } else {
            expect(wsPayload.reason).toBeUndefined()
        }
    })
})
