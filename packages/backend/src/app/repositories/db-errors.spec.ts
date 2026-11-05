import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { isServerRejection, isUniqueViolation } from './db-errors.js'

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

const pgError = (code: string): pg.DatabaseError => {
    const err = new pg.DatabaseError('could not serialize access', 0, 'error')
    err.code = code
    err.severity = 'ERROR'
    return err
}

const wrapped = (cause: unknown): Error => Object.assign(new Error('Failed query'), { cause })

// feat-135 (sixth review L5): a SQLSTATE-looking code alone was taken for PostgreSQL's answer, and
// Node errno codes of five capitals (EPIPE, EPERM) passed; an object storage swap then deleted the
// new object although its COMMIT may have gone through.
describe('isServerRejection', () => {
    it('is true for an error PostgreSQL answered, as is or wrapped by Drizzle', () => {
        expect(isServerRejection(pgError('40001'))).toBe(true)
        expect(isServerRejection(wrapped(pgError('23505')))).toBe(true)
    })

    it.each(['EPIPE', 'EPERM', 'EACCES', 'ECONNRESET', 'ETIMEDOUT'])(
        'is false for the Node errno %s, as is or wrapped',
        (code) => {
            const nodeError = Object.assign(new Error(`write ${code}`), { code, errno: -32 })
            expect(isServerRejection(nodeError)).toBe(false)
            expect(isServerRejection(wrapped(nodeError))).toBe(false)
        },
    )

    it('is false for a code without the severity PostgreSQL always sends', () => {
        expect(isServerRejection(Object.assign(new Error('x'), { code: '40001' }))).toBe(false)
    })

    it('is false without an answer at all', () => {
        expect(isServerRejection(new Error('Query read timeout'))).toBe(false)
        expect(isServerRejection(undefined)).toBe(false)
    })
})
