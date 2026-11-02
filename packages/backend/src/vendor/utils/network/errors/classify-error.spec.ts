import { describe, expect, it, vi } from 'vitest'

import { ParameterValidationError } from '#app/validate/checkers/parameter-checker.js'
import { ValidationError } from '#app/validate/errors/validation-error.js'
import { classifiedErrorBody, classifyError, logClassifiedError } from './classify-error.js'
import { HttpError } from './http-error.js'
import { MalformedBodyError } from './malformed-body-error.js'
import { PayloadTooLargeError } from './payload-too-large-error.js'
import { RedisUnavailableError } from './redis-unavailable-error.js'
import { SessionVerificationUnavailableError } from './session-verification-unavailable-error.js'
import { UnsupportedMediaTypeError } from './unsupported-media-type-error.js'

describe('classifyError: HttpError classes', () => {
    it.each([
        {
            name: 'PayloadTooLargeError',
            err: new PayloadTooLargeError(10, 'application/json'),
            status: 413,
            code: 'payload_too_large',
            message: 'Payload too large',
            details: { kind: 'payload_too_large', limit: 10, contentType: 'application/json' },
            fields: { limit: 10, contentType: 'application/json' },
            logMessage: 'Payload too large',
        },
        {
            name: 'MalformedBodyError',
            err: new MalformedBodyError('json'),
            status: 400,
            code: 'bad_request',
            message: 'Malformed json body',
            details: undefined,
            fields: { bodyKind: 'json' },
            logMessage: 'Malformed request body',
        },
        {
            name: 'UnsupportedMediaTypeError',
            err: new UnsupportedMediaTypeError(null, ['json']),
            status: 415,
            code: 'unsupported_media_type',
            message: 'Unsupported Media Type',
            details: {
                kind: 'unsupported_media_type',
                receivedContentType: null,
                allowedKinds: ['json'],
            },
            fields: { receivedContentType: null, allowedKinds: ['json'] },
            logMessage: 'Unsupported media type',
        },
    ])('$name → $status $code, warn', (c) => {
        const classified = classifyError(c.err)

        expect(classified.status).toBe(c.status)
        expect(classified.code).toBe(c.code)
        expect(classified.message).toBe(c.message)
        expect(classified.details).toEqual(c.details)
        expect(classified.headers).toEqual({})
        expect(classified.log).toEqual({ level: 'warn', fields: c.fields, message: c.logMessage })
    })

    it('ValidationError → 422 with messages and issues, warn with err', () => {
        const issues = [{ path: 'email', message: 'must be an email' }]
        const err = new ValidationError(['email must be an email'], undefined, issues)

        const classified = classifyError(err)

        expect(classified).toMatchObject({
            status: 422,
            code: 'validation_failed',
            message: 'Validation failure',
            details: { kind: 'validation', messages: ['email must be an email'], issues },
            log: { level: 'warn', fields: { err }, message: 'Handle Error' },
        })
    })

    it('ParameterValidationError → 400 parameter_validation', () => {
        const err = new ParameterValidationError('id', 'x y', 'bad id')

        expect(classifyError(err)).toMatchObject({
            status: 400,
            code: 'bad_request',
            message: 'Invalid parameter',
            details: { kind: 'parameter_validation', parameter: 'id', messages: ['bad id'] },
            log: { level: 'warn' },
        })
    })

    it('SessionVerificationUnavailableError → 503 + Retry-After, error, reaches Sentry', () => {
        const err = new SessionVerificationUnavailableError()

        const classified = classifyError(err)

        expect(classified).toMatchObject({
            status: 503,
            code: 'service_unavailable',
            message: 'Service temporarily unavailable. Try again later.',
            headers: { 'Retry-After': '1' },
            log: {
                level: 'error',
                fields: { err },
                message: 'Request failed: session verification unavailable',
            },
        })
        expect(classified.log.fields).not.toHaveProperty('sentrySkip')
    })
})

describe('classifyError: Redis outage', () => {
    // RedisUnavailableError is an HttpError too: if the generic branch ran first it would
    // lose sentrySkip and every request of an outage would become its own Sentry event.
    it('checks Redis before the generic HttpError branch', () => {
        const err = new RedisUnavailableError()
        expect(err).toBeInstanceOf(HttpError)

        const classified = classifyError(err)

        expect(classified.status).toBe(503)
        expect(classified.code).toBe('service_unavailable')
        expect(classified.headers).toEqual({ 'Retry-After': '1' })
        expect(classified.log).toEqual({
            level: 'error',
            fields: { err, sentrySkip: true },
            message: 'Request failed: Redis unavailable',
        })
    })

    it.each([
        ['offline queue disabled', new Error("Stream isn't writeable and enableOfflineQueue")],
        ['command timeout', new Error('Command timed out')],
        [
            'MaxRetriesPerRequestError',
            Object.assign(new Error('Reached the max retries'), {
                name: 'MaxRetriesPerRequestError',
            }),
        ],
    ])('a raw ioredis error from the rate-limit client (%s) gets the same answer', (_, err) => {
        const classified = classifyError(err)

        expect(classified.status).toBe(503)
        expect(classified.headers).toEqual({ 'Retry-After': '1' })
        expect(classified.log.fields).toEqual({ err, sentrySkip: true })
    })

    it('a bare socket error from another service is a 500 that reaches Sentry', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
            code: 'ECONNREFUSED',
        })

        const classified = classifyError(err)

        expect(classified.status).toBe(500)
        expect(classified.log.fields).toEqual({ err })
    })
})

describe('classifyError: anything else', () => {
    it('is a 500 internal_error without the error text', () => {
        const err = new Error('secret detail')

        const classified = classifyError(err)

        expect(classified).toEqual({
            status: 500,
            code: 'internal_error',
            message: 'Internal server error',
            headers: {},
            log: { level: 'error', fields: { err }, message: 'Handle Error' },
        })
    })

    it('shows the error text only when asked (local env)', () => {
        expect(classifyError(new Error('boom'), { exposeInternalMessage: true }).message).toBe(
            'Error: boom',
        )
    })
})

describe('logClassifiedError / classifiedErrorBody', () => {
    it('logs at the classified level', () => {
        const logger = { warn: vi.fn(), error: vi.fn() }

        logClassifiedError(logger, classifyError(new MalformedBodyError('json')))
        logClassifiedError(logger, classifyError(new Error('x')))

        expect(logger.warn).toHaveBeenCalledWith({ bodyKind: 'json' }, 'Malformed request body')
        expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('builds the body without empty details', () => {
        expect(classifiedErrorBody(classifyError(new MalformedBodyError('json')))).toEqual({
            code: 'bad_request',
            message: 'Malformed json body',
        })
    })
})
