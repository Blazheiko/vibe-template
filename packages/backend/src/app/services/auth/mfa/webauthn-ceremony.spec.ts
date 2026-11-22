import { describe, expect, it, vi } from 'vitest'

import webauthnConfig from '#config/webauthn.js'
import type { WebAuthnCredentialRow } from '#app/repositories/index.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'
import {
    authenticationOptions,
    ceremonyBinding,
    counterAdvances,
    registrationOptions,
    verifyWebAuthnCeremony,
    type CeremonyPurpose,
} from './webauthn-ceremony.js'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р5, Р6; tasks P2–P4): the shared acceptance criterion
// of WebAuthn, row by row for registration, passwordless sign-in, the second factor and step-up.
// The answers are real (a software authenticator), so this is the verification a browser meets.

const RP = webauthnConfig.rpId
const ORIGIN = webauthnConfig.origins[0] ?? ''
const USER_ID = 7n
const HANDLE = Buffer.alloc(32, 4)
const SUBJECT = 'session-1'

type SignPurpose = Exclude<CeremonyPurpose, 'register'>
const SIGN_PURPOSES: SignPurpose[] = ['login', 'mfa', 'reauth']

async function enrolled(counter = 0): Promise<{
    authenticator: SoftAuthenticator
    row: WebAuthnCredentialRow
}> {
    const authenticator = new SoftAuthenticator({ counter })
    const options = await registrationOptions({
        userHandle: HANDLE,
        userName: 'ann@example.test',
        displayName: 'Ann',
        exclude: [],
    })
    const binding = ceremonyBinding('register', SUBJECT)
    const result = await verifyWebAuthnCeremony({
        purpose: 'register',
        stored: { challenge: options.challenge, binding },
        expectedBinding: binding,
        response: authenticator.register({
            challenge: options.challenge,
            rpId: RP,
            origin: ORIGIN,
            userHandle: options.user.id,
        }),
    })
    if (!result.ok || !('registration' in result)) throw new Error('registration failed')
    const key = result.registration
    return {
        authenticator,
        row: {
            id: 1n,
            userId: USER_ID,
            credentialId: key.credentialId,
            publicKey: key.publicKey,
            signCount: key.signCount,
            transports: key.transports,
            aaguid: key.aaguid,
            deviceType: key.deviceType,
            backedUp: key.backedUp,
            name: 'Key',
            enrollmentId: 'e1',
            createdAt: new Date(),
            lastUsedAt: null,
        },
    }
}

async function signWith(
    purpose: SignPurpose,
    setup: { authenticator: SoftAuthenticator; row: WebAuthnCredentialRow },
    change: {
        origin?: string
        rpId?: string
        userVerified?: boolean
        storedBinding?: string
        expectedUserId?: bigint
        userHandle?: Buffer | null
        expectedUserHandle?: Buffer | null
        counter?: number
        challengeAnswered?: string
    } = {},
) {
    const options = await authenticationOptions(purpose === 'login' ? [] : [setup.row])
    const binding = ceremonyBinding(purpose, purpose === 'login' ? undefined : SUBJECT)
    return verifyWebAuthnCeremony({
        purpose,
        stored: { challenge: options.challenge, binding: change.storedBinding ?? binding },
        expectedBinding: binding,
        credential: setup.row,
        expectedUserId: change.expectedUserId ?? USER_ID,
        expectedUserHandle:
            change.expectedUserHandle === undefined ? HANDLE : change.expectedUserHandle,
        response: setup.authenticator.authenticate({
            challenge: change.challengeAnswered ?? options.challenge,
            rpId: change.rpId ?? RP,
            origin: change.origin ?? ORIGIN,
            ...(change.userVerified !== undefined ? { userVerified: change.userVerified } : {}),
            ...(change.userHandle !== undefined ? { userHandle: change.userHandle } : {}),
            ...(change.counter !== undefined ? { counter: change.counter } : {}),
        }),
    })
}

describe('registration (Р6)', () => {
    const register = async (change: {
        origin?: string
        rpId?: string
        userVerified?: boolean
        storedBinding?: string
        challengeAnswered?: string
    }) => {
        const options = await registrationOptions({
            userHandle: HANDLE,
            userName: 'ann@example.test',
            displayName: 'Ann',
            exclude: [],
        })
        const binding = ceremonyBinding('register', SUBJECT)
        return verifyWebAuthnCeremony({
            purpose: 'register',
            stored: { challenge: options.challenge, binding: change.storedBinding ?? binding },
            expectedBinding: binding,
            response: new SoftAuthenticator().register({
                challenge: change.challengeAnswered ?? options.challenge,
                rpId: change.rpId ?? RP,
                origin: change.origin ?? ORIGIN,
                userHandle: options.user.id,
                ...(change.userVerified !== undefined ? { userVerified: change.userVerified } : {}),
            }),
        })
    }

    it('the options ask for a discoverable key, user verification and no attestation', async () => {
        const options = await registrationOptions({
            userHandle: HANDLE,
            userName: 'ann@example.test',
            displayName: 'Ann',
            exclude: [],
        })
        expect(options.rp.id).toBe(RP)
        expect(options.user.id).toBe(HANDLE.toString('base64url'))
        expect(options.attestation).toBe('none')
        expect(options.authenticatorSelection).toMatchObject({
            residentKey: 'required',
            userVerification: 'required',
        })
    })

    it('a right answer gives the key', async () => {
        expect(await register({})).toMatchObject({ ok: true })
    })

    it.each([
        ['without user verification', { userVerified: false }, 'invalid'],
        ['from another origin', { origin: 'https://evil.test' }, 'invalid'],
        ['for another RP ID', { rpId: 'evil.test' }, 'invalid'],
        [
            'with a challenge of another purpose',
            { storedBinding: 'reauth:session-1' },
            'wrong_purpose',
        ],
        ['to another challenge', { challengeAnswered: 'b3RoZXI' }, 'invalid'],
    ] as const)('is refused %s', async (_name, change, failure) => {
        expect(await register(change)).toEqual({ ok: false, failure })
    })
})

describe.each(SIGN_PURPOSES)('a signature for %s (Р6)', (purpose) => {
    it('a right answer passes and gives the new counter', async () => {
        const setup = await enrolled(5)
        const result = await signWith(purpose, setup)
        expect(result).toEqual({ ok: true, assertion: { credentialId: 1n, newCounter: 6n } })
    })

    it.each([
        ['without user verification', { userVerified: false }, 'invalid'],
        ['from another origin', { origin: 'https://evil.test' }, 'invalid'],
        ['for another RP ID', { rpId: 'evil.test' }, 'invalid'],
        [
            'with a challenge of another purpose',
            { storedBinding: 'register:session-1' },
            'wrong_purpose',
        ],
        ['to another challenge', { challengeAnswered: 'b3RoZXI' }, 'invalid'],
        ['with a key of another user', { expectedUserId: 8n }, 'wrong_user'],
        [
            'with the user handle of another account',
            { userHandle: Buffer.alloc(32, 9) },
            'wrong_user',
        ],
    ] as const)('is refused %s', async (_name, change, failure) => {
        const setup = await enrolled()
        expect(await signWith(purpose, setup, change)).toEqual({ ok: false, failure })
    })

    it('a counter that does not grow is refused as a regression; 0 and 0 passes', async () => {
        const counting = await enrolled(5)
        counting.row.signCount = 9n
        expect(await signWith(purpose, counting, { counter: 9 })).toEqual({
            ok: false,
            failure: 'counter_regressed',
        })
        const noCounter = await enrolled(0)
        expect(await signWith(purpose, noCounter)).toMatchObject({ ok: true })
    })
})

describe('passwordless sign-in names its account by the user handle (Р6)', () => {
    it('an answer without a user handle is refused', async () => {
        const setup = await enrolled()
        expect(await signWith('login', setup, { userHandle: null })).toEqual({
            ok: false,
            failure: 'wrong_user',
        })
    })

    it('the second factor and step-up know the user already: no handle is fine', async () => {
        const setup = await enrolled()
        expect(await signWith('mfa', setup, { userHandle: null })).toMatchObject({ ok: true })
        expect(await signWith('reauth', setup, { userHandle: null })).toMatchObject({ ok: true })
    })

    it('an account without a stored handle never matches an answered one', async () => {
        const setup = await enrolled()
        expect(await signWith('login', setup, { expectedUserHandle: null })).toEqual({
            ok: false,
            failure: 'wrong_user',
        })
    })
})

describe('counterAdvances', () => {
    it.each([
        [0n, 0n, true],
        [0n, 1n, true],
        [5n, 6n, true],
        [5n, 5n, false],
        [5n, 4n, false],
        [5n, 0n, false],
    ])('%s → %s: %s', (stored, next, expected) => {
        expect(counterAdvances(stored, next)).toBe(expected)
    })
})
