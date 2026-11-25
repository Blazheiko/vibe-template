import { describe, expect, it } from 'vitest'

import { parseEntityId } from './parse-id.js'

// feat-161 (review 2026-11-10): an id PostgreSQL cannot hold used to reach the query and come
// back as a 500. feat-262: '0' and a leading zero are not ids either.
describe('parseEntityId', () => {
    it.each([
        ['1', 1n],
        ['42', 42n],
        ['9223372036854775807', 9223372036854775807n],
    ])('reads %s', (raw, expected) => {
        expect(parseEntityId(raw)).toBe(expected)
    })

    it.each([
        ['one more than bigint holds', '9223372036854775808'],
        ['thirty digits', '1'.repeat(30)],
        ['a negative number', '-5'],
        ['hexadecimal', '0x10'],
        ['a fraction', '1.5'],
        ['an exponent', '1e3'],
        ['spaces', ' 12 '],
        ['a leading space', ' 1'],
        ['a trailing space', '1 '],
        ['blanks', '  '],
        ['zero', '0'],
        ['a leading zero', '007'],
        ['letters', 'abc'],
        ['an empty string', ''],
    ])('refuses %s', (_name, raw) => {
        expect(parseEntityId(raw)).toBeNull()
    })

    it('refuses a missing value', () => {
        expect(parseEntityId(undefined)).toBeNull()
        expect(parseEntityId(null)).toBeNull()
    })
})
