import { describe, expect, it, vi } from 'vitest'

vi.mock('#config/cookies.js', () => ({
    default: {
        default: {
            path: '/',
            httpOnly: true,
            secure: true,
            maxAge: 3600,
            sameSite: 'Lax',
        },
    },
}))

import { setCookies } from './http-response-handlers.js'
import { createResponseData } from './response-data.js'
import type { HttpResponse } from '#vendor/start/server.js'

const serializeAll = (responseData: ReturnType<typeof createResponseData>): string[] => {
    const written: string[] = []
    const res = {
        writeHeader: vi.fn((name: string, value: string) => {
            if (name === 'Set-Cookie') written.push(value)
        }),
    } as unknown as HttpResponse
    setCookies(res, responseData.cookies)
    return written
}

describe('createResponseData.deleteCookie', () => {
    it('emits a tombstone with default Path=/, Max-Age=0, and empty value', () => {
        const rd = createResponseData()
        rd.deleteCookie('uapi')
        const headers = serializeAll(rd)

        expect(headers).toHaveLength(1)
        const header = headers[0]!
        expect(header).toMatch(/^uapi=;/)
        expect(header).toContain('; Path=/')
        expect(header).toContain('; Max-Age=0')
        expect(header).toContain('; Expires=Thu, 01 Jan 1970 00:00:00 GMT')
        expect(header).toContain('; Secure')
        expect(header).toContain('; SameSite=Lax')
        expect(header).not.toContain('; HttpOnly')
        expect(header).not.toContain('Domain=')
    })

    it('honors path, secure, sameSite options', () => {
        const rd = createResponseData()
        rd.deleteCookie('uapi', {
            path: '/api',
            secure: false,
            sameSite: 'Strict',
        })
        const header = serializeAll(rd)[0]!

        expect(header).toContain('; Path=/api')
        expect(header).toContain('; SameSite=Strict')
        expect(header).not.toContain('; Secure')
    })

    it('returns tombstone when setCookie then deleteCookie target the same name (last-write-wins)', () => {
        const rd = createResponseData()
        rd.setCookie('x', 'value')
        rd.deleteCookie('x')
        const header = serializeAll(rd)[0]!

        expect(header).toMatch(/^x=;/)
        expect(header).toContain('; Max-Age=0')
    })

    it('returns the new cookie when deleteCookie then setCookie target the same name', () => {
        const rd = createResponseData()
        rd.deleteCookie('x')
        rd.setCookie('x', 'fresh')
        const header = serializeAll(rd)[0]!

        expect(header).toMatch(/^x=fresh;/)
        expect(header).not.toContain('; Max-Age=0')
    })

    it('does not affect cookies with different names', () => {
        const rd = createResponseData()
        rd.setCookie('keep', 'v')
        rd.deleteCookie('drop')
        const headers = serializeAll(rd)

        expect(headers).toHaveLength(2)
        expect(headers.some((h) => h.startsWith('keep=v;') && !h.includes('Max-Age=0'))).toBe(true)
        expect(headers.some((h) => h.startsWith('drop=;') && h.includes('Max-Age=0'))).toBe(true)
    })

    it('idempotent: calling deleteCookie twice produces a single tombstone', () => {
        const rd = createResponseData()
        rd.deleteCookie('x')
        rd.deleteCookie('x')
        const headers = serializeAll(rd)

        expect(headers).toHaveLength(1)
        expect(headers[0]!).toMatch(/^x=;/)
    })

    it('deletion line never includes Domain=', () => {
        const rd = createResponseData()
        rd.deleteCookie('x', { path: '/', secure: true, sameSite: 'Lax' })
        expect(serializeAll(rd)[0]!).not.toContain('Domain=')
    })
})

describe('createResponseData.setCookie', () => {
    it('emits Secure/HttpOnly from defaults when not overridden', () => {
        const rd = createResponseData()
        rd.setCookie('a', 'v')
        const header = serializeAll(rd)[0]!

        expect(header).toContain('; HttpOnly')
        expect(header).toContain('; Secure')
        expect(header).toContain('; SameSite=Lax')
        expect(header).toContain('; Path=/')
    })
})

// feat-275: setHeader sets, it does not append.
describe('createResponseData.setHeader', () => {
    it('keeps one entry for one call', () => {
        const rd = createResponseData()
        rd.setHeader('Location', '/a')
        expect(rd.headers).toEqual([{ name: 'Location', value: '/a' }])
    })

    it('replaces the value when the same name is set again', () => {
        const rd = createResponseData()
        rd.setHeader('Retry-After', '1')
        rd.setHeader('Retry-After', '60')
        expect(rd.headers).toEqual([{ name: 'Retry-After', value: '60' }])
    })

    it('matches the name case-insensitively and keeps the first spelling', () => {
        const rd = createResponseData()
        rd.setHeader('Retry-After', '1')
        rd.setHeader('retry-after', '60')
        expect(rd.headers).toEqual([{ name: 'Retry-After', value: '60' }])
    })

    it('keeps different names in call order', () => {
        const rd = createResponseData()
        rd.setHeader('X-RateLimit-Limit', '10')
        rd.setHeader('X-RateLimit-Remaining', '9')
        rd.setHeader('X-RateLimit-Limit', '20')
        expect(rd.headers).toEqual([
            { name: 'X-RateLimit-Limit', value: '20' },
            { name: 'X-RateLimit-Remaining', value: '9' },
        ])
    })
})
