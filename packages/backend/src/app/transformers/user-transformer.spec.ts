import { describe, expect, it } from 'vitest'

import { userTransformer } from './user-transformer.js'

// Internal fields never leave the server: the password hash and the per-user
// session namespace (users.session_token, also part of the signed cookie).
const row = {
    id: 7n,
    name: 'Jane',
    email: 'jane@example.test',
    phone: null,
    password: 'hashed-password',
    sessionToken: 'abcdefghijklmnopqrstuvwx',
    avatar: null,
    role: 'user' as const,
    emailVerifiedAt: null,
    webauthnUserHandle: Buffer.alloc(32, 9),
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    updatedAt: new Date('2026-10-25T10:01:00.000Z'),
}

describe('userTransformer', () => {
    it('drops password, sessionToken and the WebAuthn user handle', () => {
        const serialized = userTransformer.serialize(row)
        expect(serialized).not.toHaveProperty('password')
        expect(serialized).not.toHaveProperty('sessionToken')
        expect(serialized).not.toHaveProperty('webauthnUserHandle')
        expect(JSON.stringify(serialized)).not.toContain('abcdefghijklmnopqrstuvwx')
        expect(serialized).toMatchObject({ id: '7', name: 'Jane', emailVerified: false })
    })
})

describe('date format (feat-047 §4.2)', () => {
    it('sends dates as UTC ISO strings whatever the process time zone', () => {
        const serialized = userTransformer.serialize({
            ...row,
            emailVerifiedAt: new Date('2026-10-25T10:02:00.000Z'),
        })
        expect(serialized).toMatchObject({
            created_at: '2026-10-25T10:00:00.000Z',
            updated_at: '2026-10-25T10:01:00.000Z',
            emailVerifiedAt: '2026-10-25T10:02:00.000Z',
        })
    })
})
