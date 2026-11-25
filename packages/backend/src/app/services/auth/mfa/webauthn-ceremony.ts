import { randomBytes } from 'node:crypto'
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'

import type { AuthenticationResponse, RegistrationResponse } from 'shared/schemas'

import webauthnConfig from '#config/webauthn.js'
import type { WebAuthnCredentialRow } from '#app/repositories/index.js'
import logger from '#vendor/utils/logger.js'
import type { UserId } from '#app/domain/ids.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р5, Р6): the one place that checks a WebAuthn answer.
// Registration, passwordless sign-in, the second sign-in step and step-up all call
// verifyWebAuthnCeremony; nothing else calls the library's verify functions (architecture test).
// Every check is the same for all four: user verification required, an exact origin of the list,
// the exact RP ID, a challenge of this purpose and binding (Р5), and for a signature the key of
// the expected user with a counter that only grows (0 and 0 is fine).

export type CeremonyPurpose = 'register' | 'login' | 'mfa' | 'reauth'

/** What a challenge was issued for (Р5): `login`, `register:<sessionId>`, `mfa:<ticket hash>`… */
export const ceremonyBinding = (purpose: CeremonyPurpose, subject?: string): string =>
    purpose === 'login' ? 'login' : `${purpose}:${subject ?? ''}`

/** A stored challenge with what it was issued for. */
export interface StoredChallenge {
    challenge: string
    binding: string
}

export type CeremonyFailure =
    /** The stored challenge belongs to another purpose or binding. */
    | 'wrong_purpose'
    /** The answer does not verify: signature, origin, RP ID, challenge or user verification. */
    | 'invalid'
    /** The key is not the expected user's (or its user handle is another account's). */
    | 'wrong_user'
    /** A signature counter that did not grow: a cloned key is possible (Р6). */
    | 'counter_regressed'

export interface VerifiedRegistration {
    credentialId: Buffer
    publicKey: Buffer
    signCount: bigint
    transports: string[] | null
    aaguid: string | null
    deviceType: string
    backedUp: boolean
}

export interface VerifiedAssertion {
    credentialId: bigint
    newCounter: bigint
}

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const fromBase64Url = (value: string): Buffer => Buffer.from(value, 'base64url')

/** A new WebAuthn user handle: 32 random bytes, never the user id or the email (Р6). */
export const newUserHandle = (): Buffer => randomBytes(32)

export async function registrationOptions(input: {
    userHandle: Buffer
    userName: string
    displayName: string
    exclude: Pick<WebAuthnCredentialRow, 'credentialId' | 'transports'>[]
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
        rpName: webauthnConfig.rpName,
        rpID: webauthnConfig.rpId,
        userName: input.userName,
        userDisplayName: input.displayName,
        userID: new Uint8Array(input.userHandle),
        attestationType: 'none',
        timeout: webauthnConfig.challengeTtlSeconds * 1000,
        excludeCredentials: input.exclude.map((key) => ({
            id: toBase64Url(key.credentialId),
            ...(key.transports !== null ? { transports: key.transports } : {}),
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
}

/** Options of a signature: no allowed keys for a passwordless sign-in, the user's keys otherwise. */
export async function authenticationOptions(
    allow: Pick<WebAuthnCredentialRow, 'credentialId' | 'transports'>[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
        rpID: webauthnConfig.rpId,
        timeout: webauthnConfig.challengeTtlSeconds * 1000,
        userVerification: 'required',
        allowCredentials: allow.map((key) => ({
            id: toBase64Url(key.credentialId),
            ...(key.transports !== null ? { transports: key.transports } : {}),
        })),
    })
}

interface CeremonyBase {
    /** The challenge as it was stored, already consumed by the caller (one-time, Р5). */
    stored: StoredChallenge
    /** What this request expects the challenge to be for. */
    expectedBinding: string
}

export type CeremonyInput =
    | (CeremonyBase & { purpose: 'register'; response: RegistrationResponse })
    | (CeremonyBase & {
          purpose: 'login' | 'mfa' | 'reauth'
          response: AuthenticationResponse
          /** The stored key the answer names (found by its credential id). */
          credential: WebAuthnCredentialRow
          /** The user the key must belong to; for a passwordless sign-in, its owner. */
          expectedUserId: UserId
          /** The owner's user handle; the answer's userHandle must equal it when given. */
          expectedUserHandle: Buffer | null
      })

export type CeremonyResult =
    | { ok: true; registration: VerifiedRegistration }
    | { ok: true; assertion: VerifiedAssertion }
    | { ok: false; failure: CeremonyFailure }

export async function verifyWebAuthnCeremony(input: CeremonyInput): Promise<CeremonyResult> {
    if (input.stored.binding !== input.expectedBinding)
        return { ok: false, failure: 'wrong_purpose' }
    const common = {
        expectedChallenge: input.stored.challenge,
        expectedOrigin: [...webauthnConfig.origins],
        expectedRPID: webauthnConfig.rpId,
        requireUserVerification: true,
    }

    if (input.purpose === 'register') {
        try {
            const verified = await verifyRegistrationResponse({
                // The shape was checked by the route schema (shared/schemas/passkeys).
                response: input.response,
                ...common,
            })
            if (!verified.verified || !verified.registrationInfo.userVerified) {
                return { ok: false, failure: 'invalid' }
            }
            const info = verified.registrationInfo
            const zeroAaguid = /^0{8}-0{4}-0{4}-0{4}-0{12}$/
            return {
                ok: true,
                registration: {
                    credentialId: fromBase64Url(info.credential.id),
                    publicKey: Buffer.from(info.credential.publicKey),
                    signCount: BigInt(info.credential.counter),
                    transports: info.credential.transports ?? null,
                    aaguid: zeroAaguid.test(info.aaguid) ? null : info.aaguid,
                    deviceType: info.credentialDeviceType,
                    backedUp: info.credentialBackedUp,
                },
            }
        } catch (err) {
            logger.info({ err }, 'passkey registration answer refused')
            return { ok: false, failure: 'invalid' }
        }
    }

    const { credential, response } = input
    if (credential.userId !== input.expectedUserId) return { ok: false, failure: 'wrong_user' }
    if (!fromBase64Url(response.id).equals(credential.credentialId)) {
        return { ok: false, failure: 'wrong_user' }
    }
    // A discoverable key names its account: it must be the key owner's handle (Р6).
    const answeredHandle = response.response.userHandle
    if (answeredHandle !== undefined && answeredHandle !== '') {
        if (
            input.expectedUserHandle === null ||
            !fromBase64Url(answeredHandle).equals(input.expectedUserHandle)
        ) {
            return { ok: false, failure: 'wrong_user' }
        }
    } else if (input.purpose === 'login') {
        // A passwordless sign-in has no other way to tell whose key it is.
        return { ok: false, failure: 'wrong_user' }
    }

    let newCounter: bigint
    try {
        const verified = await verifyAuthenticationResponse({
            response,
            ...common,
            credential: {
                id: toBase64Url(credential.credentialId),
                publicKey: new Uint8Array(credential.publicKey),
                // The counter rule is ours (below and in the conditional UPDATE); the library
                // would refuse a regression without the event.
                counter: 0,
                ...(credential.transports !== null ? { transports: credential.transports } : {}),
            },
        })
        if (!verified.verified || !verified.authenticationInfo.userVerified) {
            return { ok: false, failure: 'invalid' }
        }
        newCounter = BigInt(verified.authenticationInfo.newCounter)
    } catch (err) {
        logger.info({ err, purpose: input.purpose }, 'passkey signature refused')
        return { ok: false, failure: 'invalid' }
    }
    if (!counterAdvances(credential.signCount, newCounter)) {
        return { ok: false, failure: 'counter_regressed' }
    }
    return { ok: true, assertion: { credentialId: credential.id, newCounter } }
}

/** Р6: 0 on both sides is fine (no counter, synced passkeys); otherwise it must grow. */
export const counterAdvances = (stored: bigint, next: bigint): boolean =>
    (stored === 0n && next === 0n) || next > stored
