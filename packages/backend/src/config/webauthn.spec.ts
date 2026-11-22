import { describe, expect, it } from 'vitest'

import { parseWebAuthnConfig } from './webauthn.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the relying party of the passkeys.
const DEV = { isProductionLike: false, frontendUrl: 'http://localhost:5173', appName: 'Vibe' }
const PROD = { isProductionLike: true, frontendUrl: 'https://app.example.com', appName: 'Vibe' }

describe('parseWebAuthnConfig', () => {
    it('in development: the host and origin of FRONTEND_URL, the app name', () => {
        expect(parseWebAuthnConfig({}, DEV)).toEqual({
            rpId: 'localhost',
            rpName: 'Vibe',
            origins: ['http://localhost:5173'],
            error: null,
        })
    })

    it('in development without FRONTEND_URL: the frontend dev server', () => {
        expect(parseWebAuthnConfig({}, { ...DEV, frontendUrl: '' })).toMatchObject({
            rpId: 'localhost',
            origins: ['http://localhost:5173'],
            error: null,
        })
    })

    it('production-like needs the RP ID named', () => {
        expect(parseWebAuthnConfig({}, PROD).error).toMatch(/WEBAUTHN_RP_ID is required/)
        expect(parseWebAuthnConfig({ rpId: 'app.example.com' }, PROD)).toMatchObject({
            rpId: 'app.example.com',
            origins: ['https://app.example.com'],
            error: null,
        })
    })

    it('an exact origin list: trimmed, deduplicated, on the RP ID or below it', () => {
        expect(
            parseWebAuthnConfig(
                {
                    rpId: 'Example.com',
                    rpName: ' Shop ',
                    origins: 'https://example.com, https://app.example.com,https://example.com',
                },
                PROD,
            ),
        ).toEqual({
            rpId: 'example.com',
            rpName: 'Shop',
            origins: ['https://example.com', 'https://app.example.com'],
            error: null,
        })
    })

    it.each([
        [
            'an origin of another site',
            { rpId: 'example.com', origins: 'https://evil.test' },
            /not on the RP ID/,
        ],
        [
            'a look-alike suffix',
            { rpId: 'example.com', origins: 'https://badexample.com' },
            /not on the RP ID/,
        ],
        [
            'a path in the origin',
            { rpId: 'example.com', origins: 'https://example.com/app' },
            /not an origin/,
        ],
        [
            'plain http in production-like',
            { rpId: 'example.com', origins: 'http://example.com' },
            /must be https/,
        ],
        ['an RP ID that is a URL', { rpId: 'https://example.com' }, /must be a host name/],
    ])('refuses %s', (_name, raw, error) => {
        expect(parseWebAuthnConfig(raw, PROD).error).toMatch(error)
    })
})
