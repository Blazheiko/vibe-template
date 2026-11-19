import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

const { decodeSessionCursor, encodeSessionCursor, isAfter } = await import(
    './session-page-cursor.js'
)
const { sessionPublicId, isSessionPublicId } = await import('./session-public-id.js')

const ID = 'AbCdEfGhIjKlMnOpQrSt_-'

describe('session page cursor (feat-233, Р7)', () => {
    it('round-trips a position as opaque base64url', () => {
        const cursor = encodeSessionCursor({ createdAtMs: 1_763_500_000_123, publicId: ID })
        expect(cursor).toMatch(/^[\w-]+$/)
        expect(decodeSessionCursor(cursor)).toEqual({ createdAtMs: 1_763_500_000_123, publicId: ID })
    })

    it.each([
        ['empty', ''],
        ['not base64url', 'a b'],
        ['padding', `${Buffer.from(`1:${ID}`).toString('base64')}=`],
        ['no separator', Buffer.from(`1763500000000${ID}`).toString('base64url')],
        ['short public id', Buffer.from('1763500000000:abc').toString('base64url')],
        ['negative time', Buffer.from(`-1:${ID}`).toString('base64url')],
        ['leading zero', Buffer.from(`0123:${ID}`).toString('base64url')],
        ['too large', Buffer.from(`99999999999999999:${ID}`).toString('base64url')],
        ['extra text', Buffer.from(`1:${ID}:x`).toString('base64url')],
        ['too long', 'x'.repeat(129)],
    ])('refuses a cursor it never gave out: %s', (_, cursor) => {
        expect(decodeSessionCursor(cursor)).toBeNull()
    })

    it('orders by createdAt desc, then publicId desc', () => {
        const at = (createdAtMs: number, publicId: string) => ({ createdAtMs, publicId })
        expect(isAfter(at(1, 'b'.repeat(22)), at(2, 'a'.repeat(22)))).toBe(true)
        expect(isAfter(at(2, 'a'.repeat(22)), at(2, 'b'.repeat(22)))).toBe(true)
        expect(isAfter(at(2, 'b'.repeat(22)), at(2, 'b'.repeat(22)))).toBe(false)
        expect(isAfter(at(3, 'a'.repeat(22)), at(2, 'z'.repeat(22)))).toBe(false)
    })
})

describe('session public id (feat-233, Р5)', () => {
    it('is 22 base64url characters, stable per session id and not the id itself', () => {
        const id = crypto.randomUUID()
        const publicId = sessionPublicId(id)
        expect(isSessionPublicId(publicId)).toBe(true)
        expect(sessionPublicId(id)).toBe(publicId)
        expect(sessionPublicId(crypto.randomUUID())).not.toBe(publicId)
        expect(publicId).not.toContain(id.slice(0, 8))
    })
})
