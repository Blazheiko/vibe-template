import type { HttpRequest } from 'uWebSockets.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import logger from '#vendor/utils/logger.js'
import { getHeaders } from './http-request-handlers.js'

/**
 * feat-206 (L-14): headers are read before the rate limit, so a request that ends in a 429
 * is read too. A warning per refused header let one request write as many log lines as it
 * has headers.
 */
vi.mock('#vendor/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('uWebSockets.js', () => ({ getParts: vi.fn() }))

const request = (headers: [string, string][]): HttpRequest =>
    ({
        forEach: (callback: (key: string, value: string) => void) => {
            for (const [key, value] of headers) callback(key, value)
        },
    }) as unknown as HttpRequest

beforeEach(() => {
    vi.clearAllMocks()
})

describe('getHeaders: refused headers in the log', () => {
    it('writes one debug line for 100 invalid headers, with the count and a few names', () => {
        const invalid = Array.from({ length: 100 }, (_, index): [string, string] => [
            `x-bad-${String(index)}`,
            'café',
        ])

        const headers = getHeaders(request([['accept', 'text/html'], ...invalid]))

        expect([...headers.keys()]).toEqual(['accept'])
        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.debug).toHaveBeenCalledTimes(1)
        expect(logger.debug).toHaveBeenCalledWith(
            { invalid: 100, names: ['x-bad-0', 'x-bad-1', 'x-bad-2'] },
            'Invalid headers skipped',
        )
    })

    it('cuts a long name', () => {
        getHeaders(request([['x-'.padEnd(500, 'a'), 'café']]))

        expect(logger.debug).toHaveBeenCalledWith(
            { invalid: 1, names: ['x-'.padEnd(64, 'a')] },
            'Invalid headers skipped',
        )
    })

    it('writes nothing when every header is valid', () => {
        getHeaders(request([['accept', 'text/html']]))

        expect(logger.debug).not.toHaveBeenCalled()
    })
})
