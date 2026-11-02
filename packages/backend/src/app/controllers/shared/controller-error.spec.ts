import { Result } from 'better-result'
import { describe, expect, it, vi } from 'vitest'
import { badRequest, forbidden, internal } from '#app/services/shared/errors.js'
import { mapControllerError, mapWsControllerError } from './controller-error.js'

const httpContext = (aborted = false) => {
    const controller = new AbortController()
    if (aborted) controller.abort()
    return {
        responseData: { status: 200, setHeader: vi.fn() } as any,
        logger: { error: vi.fn() } as any,
        signal: controller.signal,
    }
}

const wsContext = (aborted = false) => {
    const controller = new AbortController()
    if (aborted) controller.abort()
    return {
        responseData: { status: '200' } as any,
        logger: { error: vi.fn() } as any,
        signal: controller.signal,
    }
}

describe('mapControllerError', () => {
    it('applies status and returns error payload', () => {
        const context = httpContext()

        const result = mapControllerError(context, badRequest('X'))

        expect(context.responseData.status).toBe(400)
        expect(result).toEqual({ status: 'error', code: 'bad_request', message: 'X' })
        expect(context.logger.error).not.toHaveBeenCalled()
    })

    it('logs a 5xx error with its cause through the request logger', () => {
        const context = httpContext()
        const cause = new Error('S3 is down')

        const result = mapControllerError(context, internal(cause, 'Failed to upload avatar'))

        expect(context.responseData.status).toBe(500)
        expect(result).toEqual({
            status: 'error',
            code: 'internal_error',
            message: 'Failed to upload avatar',
        })
        expect(context.logger.error).toHaveBeenCalledTimes(1)
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: cause, appError: 'Internal' },
            'Failed to upload avatar',
        )
    })

    it('does not log when the client has already gone away', () => {
        const context = httpContext(true)

        mapControllerError(context, internal(new Error('cancelled'), 'AI provider error'))

        expect(context.responseData.status).toBe(500)
        expect(context.logger.error).not.toHaveBeenCalled()
    })
})

describe('mapWsControllerError', () => {
    it('writes the HTTP-like status into the WS reply and returns the error body', () => {
        const context = wsContext()

        const result = mapWsControllerError(context, forbidden('Access denied'))

        expect(context.responseData.status).toBe('403')
        expect(result).toEqual({ status: 'error', code: 'forbidden', message: 'Access denied' })
        expect(context.logger.error).not.toHaveBeenCalled()
    })

    it('logs a 5xx error with its cause', () => {
        const context = wsContext()
        const cause = new Error('db down')

        mapWsControllerError(context, internal(cause, 'Support: failed'))

        expect(context.responseData.status).toBe('500')
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: cause, appError: 'Internal' },
            'Support: failed',
        )
    })

    it('does not log after the connection closed', () => {
        const context = wsContext(true)

        mapWsControllerError(context, internal(new Error('closed'), 'Support: failed'))

        expect(context.logger.error).not.toHaveBeenCalled()
    })
})

describe('respond', () => {
    it('returns the value as is', async () => {
        const { respond } = await import('./controller-error.js')
        const context = httpContext()

        expect(respond(context, Result.ok({ a: 1 }))).toEqual({ a: 1 })
        expect(context.responseData.status).toBe(200)
    })

    it('maps the value through toBody', async () => {
        const { respond } = await import('./controller-error.js')
        const context = httpContext()

        const body = respond(context, Result.ok({ item: 'x' }), (value) => ({
            status: 'ok' as const,
            data: value.item,
        }))

        expect(body).toEqual({ status: 'ok', data: 'x' })
    })

    it('answers an error like mapControllerError and never calls toBody', async () => {
        const { respond } = await import('./controller-error.js')
        const context = httpContext()
        const toBody = vi.fn()

        const body = respond(context, Result.err(badRequest('bad', 'why')), toBody)

        expect(context.responseData.status).toBe(400)
        expect(body).toEqual({
            status: 'error',
            code: 'bad_request',
            message: 'bad',
            reason: 'why',
        })
        expect(toBody).not.toHaveBeenCalled()
    })
})

describe('respondWs', () => {
    it('writes the WS status for an error and returns the value otherwise', async () => {
        const { respondWs } = await import('./controller-error.js')
        const failed = wsContext()
        const ok = wsContext()

        expect(respondWs(failed, Result.err(forbidden('Access denied')))).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
        expect(failed.responseData.status).toBe('403')
        expect(respondWs(ok, Result.ok({ status: 'success' }))).toEqual({ status: 'success' })
        expect(ok.responseData.status).toBe('200')
    })
})
