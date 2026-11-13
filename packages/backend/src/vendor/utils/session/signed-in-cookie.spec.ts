import { describe, expect, it, vi } from 'vitest'

// feat-202: the check the server makes before it reads the body of a route that takes one
// only from a signed-in user. It repeats the signature scheme of token-handler.ts (see the
// comment there); these cases hold the two together.
vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { createSignedToken, createAnonSessionToken } = await import('./token-handler.js')
const { ANON_SESSION_NAMESPACE } = await import('./session-ttl.js')
const { isSignedInSessionCookie } = await import('./signed-in-cookie.js')

describe('isSignedInSessionCookie', () => {
    it('accepts the cookie token-handler.ts makes for a signed-in session', () => {
        expect(isSignedInSessionCookie(createSignedToken('user-token-1.session-1'))).toBe(true)
    })

    it('refuses the cookie of a stored anonymous session, well signed as it is', () => {
        expect(
            isSignedInSessionCookie(createSignedToken(`${ANON_SESSION_NAMESPACE}.session-1`)),
        ).toBe(false)
    })

    it('refuses the cookie-held anonymous session', () => {
        const anonymous = createAnonSessionToken({
            sessionId: 's1',
            csrfToken: 'c1',
            issuedAt: 1_700_000_000,
        })

        expect(isSignedInSessionCookie(anonymous)).toBe(false)
    })

    it('refuses a cookie whose signature was made up or belongs to other data', () => {
        const real = Buffer.from(createSignedToken('user-token-1.session-1'), 'base64')
            .toString('utf-8')
            .split('.')
        const forged = (userToken: string, sessionId: string, signature: string): string =>
            Buffer.from(`${userToken}.${sessionId}.${signature}`).toString('base64')

        expect(isSignedInSessionCookie(forged('user-token-1', 'session-1', 'a'.repeat(32)))).toBe(
            false,
        )
        // The signature of one session does not sign another.
        expect(isSignedInSessionCookie(forged('user-token-2', 'session-1', real[2] ?? ''))).toBe(
            false,
        )
        expect(isSignedInSessionCookie(forged('user-token-1', 'session-1', 'zz'))).toBe(false)
        expect(isSignedInSessionCookie(forged('user-token-1', 'session-1', 'g'.repeat(32)))).toBe(
            false,
        )
    })

    it.each([undefined, '', 'not base64 at all !!!', Buffer.from('a.b').toString('base64')])(
        'refuses %j',
        (token) => {
            expect(isSignedInSessionCookie(token)).toBe(false)
        },
    )
})
