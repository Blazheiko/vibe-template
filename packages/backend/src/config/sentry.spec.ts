import { describe, expect, it } from 'vitest'

import { parseTraceSampleRate } from './sentry.js'

describe('parseTraceSampleRate (SENTRY_TRACES_SAMPLE_RATE, feat-113)', () => {
    it.each([undefined, '', '  '])('is 0 without a value (%s)', (value) => {
        expect(parseTraceSampleRate(value)).toEqual({ value: 0, error: null })
    })

    it.each([
        ['0', 0],
        ['1', 1],
        ['0.25', 0.25],
        ['.5', 0.5],
        [' 1.0 ', 1],
    ])('reads %s', (value, expected) => {
        expect(parseTraceSampleRate(value)).toEqual({ value: expected, error: null })
    })

    it.each(['1.5', '-0.1', 'abc', 'NaN', 'Infinity', '1e-1', '0x1', '50%'])(
        'reports %s as a config error',
        (value) => {
            expect(parseTraceSampleRate(value)).toEqual({
                value: 0,
                error: `SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1, got "${value}"`,
            })
        },
    )
})
