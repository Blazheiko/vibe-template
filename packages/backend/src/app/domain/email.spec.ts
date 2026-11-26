import { describe, expect, it } from 'vitest'

import { normalizeEmail, type NormalizedEmail } from './email.js'
import type { IUserRepository } from '#app/repositories/user/user-repository.js'

// feat-266 (ADR 0007, plan Р6): only normalizeEmail makes the stored form of an address, so a
// lookup by the text a client sent does not compile. The calls behind `() =>` are never run.
describe('NormalizedEmail', () => {
    it('is the trimmed lower-case form', () => {
        expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com')
        expect(normalizeEmail(normalizeEmail('A@B.C'))).toBe('a@b.c')
    })

    it('is required by the user lookup', () => {
        const repository = {} as Pick<IUserRepository, 'findByEmail'>
        const typeCases = () => [
            repository.findByEmail(normalizeEmail('Jane@Example.com')),
            // @ts-expect-error the address a client sent is looked up only after normalizeEmail
            repository.findByEmail('Jane@Example.com'),
        ]
        expect(typeof typeCases).toBe('function')
        // @ts-expect-error a string is not a NormalizedEmail
        const stored: NormalizedEmail = 'jane@example.com'
        expect(stored).toBe('jane@example.com')
    })
})
