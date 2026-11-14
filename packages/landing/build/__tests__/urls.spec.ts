import { describe, expect, it } from 'vitest'
import {
    DEFAULT_APP_URL,
    DEFAULT_SITE_URL,
    normalizeOrigin,
    parseStrict,
    productionProblem,
    resolveLandingUrls,
} from '../urls'

describe('normalizeOrigin', () => {
    it('drops the trailing slash and keeps the port', () => {
        expect(normalizeOrigin('https://app.example.com/', 'X')).toBe('https://app.example.com')
        expect(normalizeOrigin('http://localhost:5173', 'X')).toBe('http://localhost:5173')
    })

    it.each([
        ['app.example.com', 'is not an absolute URL'],
        ['ftp://app.example.com', 'must use http or https'],
        ['https://example.com/landing/', 'must be an origin'],
        ['https://example.com/?a=1', 'must be an origin'],
        ['https://user:pass@example.com', 'must not carry credentials'],
    ])('refuses %s', (value, message) => {
        expect(() => normalizeOrigin(value, 'LANDING_APP_URL')).toThrow(message)
    })
})

describe('parseStrict', () => {
    it('is off unless set to true', () => {
        expect(parseStrict(undefined)).toBe(false)
        expect(parseStrict('')).toBe(false)
        expect(parseStrict('false')).toBe(false)
        expect(parseStrict('true')).toBe(true)
    })

    it('refuses any other value', () => {
        expect(() => parseStrict('1')).toThrow('must be true or false')
    })
})

describe('productionProblem', () => {
    it.each([
        ['http://app.vibe.dev', 'must use https'],
        ['https://localhost:3000', 'points to the local machine'],
        ['https://127.0.0.1', 'points to the local machine'],
        ['https://app.localhost', 'points to the local machine'],
        ['https://app.example.com', 'is a placeholder domain (RFC 2606)'],
        ['https://vibe-template.example', 'is a placeholder domain (RFC 2606)'],
        ['https://example.org', 'is a placeholder domain (RFC 2606)'],
    ])('%s %s', (url, problem) => {
        expect(productionProblem(url)).toBe(problem)
    })

    it('accepts a public https address', () => {
        expect(productionProblem('https://app.vibe.dev/login')).toBeNull()
        expect(productionProblem('https://myexample.com')).toBeNull()
    })
})

describe('resolveLandingUrls', () => {
    it('defaults to the dev servers', () => {
        expect(resolveLandingUrls({})).toEqual({
            appUrl: DEFAULT_APP_URL,
            siteUrl: DEFAULT_SITE_URL,
            strict: false,
        })
    })

    it('takes FRONTEND_URL and LANDING_URL from packages/backend/.env', () => {
        const urls = resolveLandingUrls(
            {},
            { FRONTEND_URL: 'http://localhost:3000/', LANDING_URL: 'http://localhost:8080' },
        )
        expect(urls).toMatchObject({
            appUrl: 'http://localhost:3000',
            siteUrl: 'http://localhost:8080',
        })
    })

    it('prefers the shell over the backend .env', () => {
        const urls = resolveLandingUrls(
            { LANDING_APP_URL: 'https://app.vibe.dev', LANDING_SITE_URL: 'https://vibe.dev' },
            { FRONTEND_URL: 'http://localhost:5173', LANDING_URL: 'http://localhost:5175' },
        )
        expect(urls).toMatchObject({ appUrl: 'https://app.vibe.dev', siteUrl: 'https://vibe.dev' })
    })

    it('refuses one origin for both and names where the values came from', () => {
        expect(() =>
            resolveLandingUrls(
                {},
                { FRONTEND_URL: 'http://localhost:5173', LANDING_URL: 'http://localhost:5173/' },
            ),
        ).toThrow(
            /LANDING_URL in packages\/backend\/\.env\).*FRONTEND_URL in packages\/backend\/\.env\).*same origin/,
        )
    })

    it('in strict mode refuses local and placeholder addresses', () => {
        expect(() => resolveLandingUrls({ LANDING_STRICT: 'true' })).toThrow('LANDING_STRICT=true')
        expect(() =>
            resolveLandingUrls({
                LANDING_STRICT: 'true',
                LANDING_APP_URL: 'https://app.example.com',
                LANDING_SITE_URL: 'https://vibe.dev',
            }),
        ).toThrow('LANDING_APP_URL: "https://app.example.com" is a placeholder domain')
    })

    it('in strict mode accepts public https addresses', () => {
        expect(
            resolveLandingUrls({
                LANDING_STRICT: 'true',
                LANDING_APP_URL: 'https://app.vibe.dev',
                LANDING_SITE_URL: 'https://vibe.dev',
            }).strict,
        ).toBe(true)
    })
})
