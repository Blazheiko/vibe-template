import { describe, expect, it } from 'vitest'

import { createWsErrorEnvelope, setWsError } from './ws-error-envelope.js'
import type { WsResponseData } from '#vendor/types/types.js'

describe('ws-error-envelope', () => {
    it('adds reason and details only when given', () => {
        expect(createWsErrorEnvelope('not_found', 'Route not found')).toEqual({
            code: 'not_found',
            message: 'Route not found',
        })
        expect(
            createWsErrorEnvelope('rate_limited', 'Slow down', { reason: 'r', details: { a: 1 } }),
        ).toEqual({ code: 'rate_limited', message: 'Slow down', reason: 'r', details: { a: 1 } })
    })

    it('setWsError sets status error, data null and the envelope', () => {
        const responseData: WsResponseData = {
            event: 'api/x',
            timestamp: 1,
            status: '200',
            data: { partial: true },
            error: null,
        }
        setWsError(responseData, createWsErrorEnvelope('internal_error', 'Internal server error'))
        expect(responseData).toEqual({
            event: 'api/x',
            timestamp: 1,
            status: 'error',
            data: null,
            error: { code: 'internal_error', message: 'Internal server error' },
        })
    })
})
