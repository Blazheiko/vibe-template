import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCsrfConfig, isExactOrigin } from './csrf.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    vi.resetModules()
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
})

const dev = { isProductionLike: false, appUrl: '', frontendUrl: '' }
const prod = { isProductionLike: true, appUrl: '', frontendUrl: '' }

describe('buildCsrfConfig', () => {
    it('enforces and requires an origin by default', () => {
        const config = buildCsrfConfig({ CSRF_ALLOWED_ORIGINS: 'https://app.test' }, prod)
        expect(config.enforce).toBe(true)
        expect(config.strictOrigin).toBe(true)
        expect(config.configError).toBeNull()
        expect(config.warnings).toEqual([])
    })

    it('enforces by default outside production too, without a warning', () => {
        const config = buildCsrfConfig({ CSRF_ALLOWED_ORIGINS: 'http://localhost:5173' }, dev)
        expect(config.enforce).toBe(true)
        expect(config.strictOrigin).toBe(true)
        expect(config.warnings).toEqual([])
    })

    it.each([[''], ['  '], ['yes'], ['1']])(
        'never turns protection off from a non-false value %j',
        (value) => {
            const config = buildCsrfConfig(
                {
                    CSRF_ENFORCE: value,
                    CSRF_STRICT_ORIGIN: value,
                    CSRF_ALLOWED_ORIGINS: 'https://app.test',
                },
                prod,
            )
            expect(config.enforce || config.configError !== null).toBe(true)
            expect(config.strictOrigin || config.configError !== null).toBe(true)
        },
    )

    it('keeps an explicit false', () => {
        const config = buildCsrfConfig({ CSRF_ENFORCE: 'false', CSRF_STRICT_ORIGIN: 'false' }, dev)
        expect(config.enforce).toBe(false)
        expect(config.strictOrigin).toBe(false)
    })

    it.each([
        ['development', dev],
        ['production-like', prod],
    ])('warns about each switched-off check in %s', (_name, context) => {
        const enforceOff = buildCsrfConfig(
            { CSRF_ENFORCE: 'false', CSRF_ALLOWED_ORIGINS: 'https://app.test' },
            context,
        )
        expect(enforceOff.configError).toBeNull()
        expect(enforceOff.warnings).toEqual([
            'CSRF_ENFORCE=false: CSRF protection is off, violations are only logged, not rejected',
        ])

        const strictOff = buildCsrfConfig(
            { CSRF_STRICT_ORIGIN: 'false', CSRF_ALLOWED_ORIGINS: 'https://app.test' },
            context,
        )
        expect(strictOff.warnings).toEqual([
            'CSRF_STRICT_ORIGIN=false: unsafe requests without Origin and Referer are not rejected',
        ])
    })

    it('trims and splits the allowlist', () => {
        const config = buildCsrfConfig(
            { CSRF_ALLOWED_ORIGINS: ' https://a.test , http://localhost:5173,, ' },
            prod,
        )
        expect(config.allowedOrigins).toEqual(['https://a.test', 'http://localhost:5173'])
        expect(config.effectiveAllowedOrigins).toEqual(config.allowedOrigins)
    })

    it.each([['https://a.test/'], ['https://a.test/app'], ['ftp://a.test'], ['a.test'], ['*']])(
        'rejects %j as an allowlist entry in any environment',
        (origin) => {
            for (const context of [dev, prod]) {
                const config = buildCsrfConfig({ CSRF_ALLOWED_ORIGINS: origin }, context)
                expect(config.configError).toContain('CSRF_ALLOWED_ORIGINS must list exact')
                expect(config.configError).toContain(`"${origin}"`)
            }
        },
    )

    it('requires the allowlist in production-like environments', () => {
        const config = buildCsrfConfig({}, prod)
        expect(config.configError).toBe(
            'CSRF_ALLOWED_ORIGINS must be set in production-like environments',
        )
        expect(config.effectiveAllowedOrigins).toEqual([])
    })

    it('falls back to APP_URL/FRONTEND_URL origins outside production and warns', () => {
        const config = buildCsrfConfig(
            {},
            {
                isProductionLike: false,
                appUrl: 'http://localhost:3000/api',
                frontendUrl: 'http://localhost:5173',
            },
        )
        expect(config.configError).toBeNull()
        expect(config.effectiveAllowedOrigins).toEqual([
            'http://localhost:3000',
            'http://localhost:5173',
        ])
        expect(config.warnings).toEqual([
            'CSRF_ALLOWED_ORIGINS is empty: CSRF origin checks fall back to APP_URL/FRONTEND_URL (http://localhost:3000, http://localhost:5173)',
        ])
    })

    it('drops invalid and duplicate fallback URLs', () => {
        const config = buildCsrfConfig(
            {},
            { isProductionLike: false, appUrl: 'not a url', frontendUrl: 'http://x.test/a' },
        )
        expect(config.effectiveAllowedOrigins).toEqual(['http://x.test'])

        const same = buildCsrfConfig(
            {},
            { isProductionLike: false, appUrl: 'http://x.test', frontendUrl: 'http://x.test/' },
        )
        expect(same.effectiveAllowedOrigins).toEqual(['http://x.test'])
    })

    it('warns that any origin passes when there is no fallback either', () => {
        const config = buildCsrfConfig({}, dev)
        expect(config.effectiveAllowedOrigins).toEqual([])
        expect(config.warnings).toEqual([
            'CSRF_ALLOWED_ORIGINS is empty and APP_URL/FRONTEND_URL give no origin: CSRF origin checks accept any well-formed origin',
        ])
    })
})

describe('isExactOrigin', () => {
    it.each([
        ['https://a.test', true],
        ['http://localhost:5173', true],
        ['https://a.test/', false],
        ['https://a.test:443', false],
        ['null', false],
        ['', false],
    ])('%j → %s', (value, expected) => {
        expect(isExactOrigin(value)).toBe(expected)
    })
})

describe('csrf config from the environment', () => {
    const load = async () => (await import('./csrf.js')).default

    it.each([
        [{ APP_ENV: 'prod' }],
        [{ APP_ENV: undefined, NODE_ENV: 'production' }],
        [{ APP_ENV: 'staging', APP_IS_PRODUCTION: 'true' }],
    ])('treats %j as production-like', async (vars) => {
        delete process.env['CSRF_ALLOWED_ORIGINS']
        delete process.env['APP_IS_PRODUCTION']
        for (const [key, value] of Object.entries(vars)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        expect((await load()).configError).toBe(
            'CSRF_ALLOWED_ORIGINS must be set in production-like environments',
        )
    })

    it('stops the start through validateRuntimeConfig', async () => {
        process.env['CSRF_ALLOWED_ORIGINS'] = 'https://a.test/'
        const { validateRuntimeConfig } = await import('#app/start/validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(/Invalid CSRF configuration: CSRF_ALLOWED_ORIGINS must list exact/)
    })
})
