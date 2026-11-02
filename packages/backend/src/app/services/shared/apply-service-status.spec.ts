import { describe, expect, it } from 'vitest'
import { applyAppErrorStatus } from './apply-service-status.js'
import { appErrorToPayload } from './app-error-payload.js'
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

describe('apply-service-status', () => {
    it.each(APP_ERROR_CASES)(
        'maps %s to the expected HTTP status',
        ({ error, status }: AppErrorCase) => {
            const responseData = { status: 200, payload: null } as any

            applyAppErrorStatus(responseData, error)

            expect(responseData.status).toBe(status)
        },
    )

    it('keeps internal public messages in the payload', () => {
        expect(appErrorToPayload(APP_ERROR_CASES[5].error)).toEqual({
            status: 'error',
            message: 'Hidden',
            code: 'internal_error',
        })
    })
})
