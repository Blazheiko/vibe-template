import { describe, expect, it } from 'vitest'

import { isUniqueViolation } from './db-errors.js'

describe('isUniqueViolation', () => {
    it.each([
        ['the driver error', Object.assign(new Error('duplicate key'), { code: '23505' })],
        [
            'a Drizzle wrapper with the driver error as cause',
            new Error('Failed query', {
                cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
            }),
        ],
    ])('recognises %s', (_, err) => {
        expect(isUniqueViolation(err)).toBe(true)
    })

    it.each([
        ['another code', Object.assign(new Error('fk'), { code: '23503' })],
        ['no code', new Error('boom')],
        ['not an Error', '23505'],
    ])('rejects %s', (_, err) => {
        expect(isUniqueViolation(err)).toBe(false)
    })
})
