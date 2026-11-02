import { describe, expect, it } from 'vitest'
import { createEnvReader } from './env-reader.js'
import { parseBoolean } from './parse-boolean.js'
import { parseInteger } from './read-int.js'

// feat-082 (N): the one reading of booleans and integers, as documented in
// documentation/backend/configuration.md.

describe('parseBoolean', () => {
    it.each([
        ['true', true],
        ['TRUE', true],
        ['True', true],
        ['1', true],
        ['yes', true],
        ['YES', true],
        ['on', true],
        [' On ', true],
        ['false', false],
        ['FALSE', false],
        ['0', false],
        ['no', false],
        ['off', false],
        [' OFF\n', false],
    ])('%j -> %s', (raw, expected) => {
        expect(parseBoolean('FLAG', raw, !expected)).toEqual({ value: expected, error: null })
    })

    it.each([undefined, '', '   '])('%j is the default, whichever it is', (raw) => {
        expect(parseBoolean('FLAG', raw, true)).toEqual({ value: true, error: null })
        expect(parseBoolean('FLAG', raw, false)).toEqual({ value: false, error: null })
    })

    it.each(['2', 'y', 'n', 't', 'enabled', 'disable', 'truee', '-1', '1.0', 'null', 'tru e'])(
        '%j is an error naming the variable, with the default as the value',
        (raw) => {
            const result = parseBoolean('MY_FLAG', raw, true)
            expect(result.value).toBe(true)
            expect(result.error).toBe(
                `MY_FLAG must be one of true, 1, yes, on, false, 0, no, off, got "${raw}"`,
            )
        },
    )
})

describe('parseInteger', () => {
    const atLeast1 = { min: 1 }

    it.each([
        ['5', 5],
        ['  42  ', 42],
        ['007', 7],
        ['9007199254740991', 9_007_199_254_740_991],
    ])('%j -> %d', (raw, expected) => {
        expect(parseInteger('N', raw, 3, atLeast1)).toEqual({ value: expected, error: null })
    })

    it.each([undefined, '', '  '])('%j is the fallback', (raw) => {
        expect(parseInteger('N', raw, 3, atLeast1)).toEqual({ value: 3, error: null })
    })

    it.each(['1e3', '0x10', '-5', '+5', '1.5', '5.0', '1_000', 'abc', '5 5', 'Infinity', 'NaN'])(
        '%j is not a decimal integer',
        (raw) => {
            expect(parseInteger('N', raw, 3, atLeast1)).toEqual({
                value: 3,
                error: `N must be an integer >= 1, got "${raw}"`,
            })
        },
    )

    it('does not take a number beyond the safe integers', () => {
        expect(parseInteger('N', '9007199254740993', 3, atLeast1).error).toContain('got')
    })

    it('holds the bounds, both ends included', () => {
        const range = { min: 50, max: 30_000 }
        expect(parseInteger('N', '50', 1000, range).value).toBe(50)
        expect(parseInteger('N', '30000', 1000, range).value).toBe(30_000)
        expect(parseInteger('N', '49', 1000, range)).toEqual({
            value: 1000,
            error: 'N must be an integer from 50 to 30000, got "49"',
        })
        expect(parseInteger('N', '30001', 1000, range).error).not.toBeNull()
    })

    it('allows 0 where the minimum is 0, and says so', () => {
        expect(parseInteger('N', '0', 5, { min: 0 })).toEqual({ value: 0, error: null })
        expect(parseInteger('N', '0', 5, atLeast1).error).toBe('N must be an integer >= 1, got "0"')
    })
})

describe('createEnvReader', () => {
    it('reads from the environment it is given and reports every problem at once', () => {
        const reader = createEnvReader({ A: 'yes', B: '1e3', C: 'maybe', D: '12' })
        expect(reader.bool('A', false)).toBe(true)
        expect(reader.int('B', 7, { min: 1 })).toBe(7)
        expect(reader.bool('C', true)).toBe(true)
        expect(reader.int('D', 7, { min: 1 })).toBe(12)
        expect(reader.int('MISSING', 9, { min: 1 })).toBe(9)
        expect(reader.error).toBe(
            'B must be an integer >= 1, got "1e3"; ' +
                'C must be one of true, 1, yes, on, false, 0, no, off, got "maybe"',
        )
    })

    it('has no error when all is well', () => {
        const reader = createEnvReader({ A: 'off' })
        reader.bool('A', true)
        expect(reader.error).toBeNull()
    })
})
