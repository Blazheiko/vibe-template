import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import type { AuthenticationResponse, RegistrationResponse } from 'shared/schemas'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р15): the browser side of a passkey ceremony. The
// library is loaded only when a passkey is used (bundle graph, ADR 0005). The server's options go
// to the library as they are, and its answer goes back to the server as it is.

type Library = typeof import('@simplewebauthn/browser')

let library: Promise<Library> | null = null
const load = (): Promise<Library> => (library ??= import('@simplewebauthn/browser'))

/** What a ceremony that did not finish tells the user. */
export type PasskeyFailure =
    /** The user closed the dialog, the time ran out, or another ceremony replaced this one. */
    | 'cancelled'
    /** The browser or the device offers no passkeys. */
    | 'unsupported'
    /** The authenticator holds a key of this account already (registration). */
    | 'exists'
    | 'failed'

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; failure: PasskeyFailure }

const failureOf = (err: unknown): PasskeyFailure => {
    const name = (err as { name?: unknown } | null)?.name
    const code = (err as { code?: unknown } | null)?.code
    if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
        return 'exists'
    }
    if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') {
        return 'cancelled'
    }
    if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported'
    return 'failed'
}

/** Whether this browser can use passkeys at all. */
export async function passkeysSupported(): Promise<boolean> {
    if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return false
    const { browserSupportsWebAuthn } = await load()
    return browserSupportsWebAuthn()
}

/** Whether the browser can offer passkeys in the autofill of the sign-in field. */
export async function passkeyAutofillSupported(): Promise<boolean> {
    if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return false
    const { browserSupportsWebAuthnAutofill } = await load()
    return browserSupportsWebAuthnAutofill()
}

export async function createPasskey(
    options: unknown,
): Promise<PasskeyResult<RegistrationResponse>> {
    try {
        const { startRegistration } = await load()
        const response: RegistrationResponseJSON = await startRegistration({
            optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
        })
        return { ok: true, value: response }
    } catch (err) {
        return { ok: false, failure: failureOf(err) }
    }
}

/**
 * A signature with a passkey. `autofill` waits for the user to pick a passkey in the sign-in
 * field's suggestions (conditional UI) instead of opening a dialog.
 */
export async function usePasskey(
    options: unknown,
    autofill = false,
): Promise<PasskeyResult<AuthenticationResponse>> {
    try {
        const { startAuthentication } = await load()
        const response: AuthenticationResponseJSON = await startAuthentication({
            optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
            useBrowserAutofill: autofill,
        })
        return { ok: true, value: response }
    } catch (err) {
        return { ok: false, failure: failureOf(err) }
    }
}
