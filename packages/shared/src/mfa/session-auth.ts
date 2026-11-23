// feat-245 (docs/plan/passkeys-mfa-plan.md, Р1, Р2): how a signed-in session was authenticated.
// Three separate things: the level the session was created with (never raised afterwards), the
// freshness of each method proven in it (sign-in or step-up) and the recovery state. Plain data,
// no schema library: the frontend reads `recovery` from main/init.

/** A method of a sign-in or a step-up, as stored in the session (`amr`, `verified`). */
export const AUTH_METHOD_REFS = ['pwd', 'oauth', 'otp', 'webauthn', 'recovery'] as const
export type AuthMethodRef = (typeof AUTH_METHOD_REFS)[number]

/** A method whose freshness is tracked (a recovery code is never a step-up, Р3). */
export type VerifiedMethodRef = Exclude<AuthMethodRef, 'recovery'>

/** What a client may present as a step-up proof (Р3). */
export const PROOF_METHODS = ['password', 'totp', 'webauthn'] as const
export type ProofMethod = (typeof PROOF_METHODS)[number]

export const PROOF_METHOD_REF: Readonly<Record<ProofMethod, VerifiedMethodRef>> = {
    password: 'pwd',
    totp: 'otp',
    webauthn: 'webauthn',
}

/** A second factor a recovery session may install to replace a lost one (Р8). */
export type FactorKind = 'totp' | 'webauthn'

export interface RecoveryState {
    startedAt: string
    /** startedAt + MFA_RECOVERY_WINDOW_SECONDS; absolute, never extended. */
    expiresAt: string
    /** The new factor version installed in this recovery session (state R+). */
    replacementFactor?: { kind: FactorKind; id: string; at: string }
}

export interface SessionAuthState {
    v: 1
    /** The methods of the sign-in that created the session. */
    amr: AuthMethodRef[]
    /** 2 only when the sign-in proved TOTP or a passkey; never raised afterwards. */
    aal: 1 | 2
    authenticatedAt: string
    /** The last time each method was proven in this session (ISO). */
    verified: Partial<Record<VerifiedMethodRef, string>>
    recovery?: RecoveryState
}

/** A session stored before feat-245 has no `auth`: level 1, nothing fresh (Р2). */
export const LEGACY_SESSION_AUTH: Readonly<SessionAuthState> = Object.freeze({
    v: 1,
    amr: [],
    aal: 1,
    authenticatedAt: new Date(0).toISOString(),
    verified: {},
})

export const sessionAuthOf = (auth: SessionAuthState | undefined | null): SessionAuthState =>
    auth ?? LEGACY_SESSION_AUTH

const timeOf = (iso: string | undefined): number | null => {
    if (iso === undefined) return null
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : null
}

/** How far ahead of `now` a mark may be and still count (clock skew between instances). */
export const MARK_CLOCK_SKEW_MS = 60_000

/**
 * Whether `method` was proven in this session within `windowSeconds` before `now`. A mark in the
 * future (clock skew between instances) counts as fresh only up to one minute ahead.
 */
export function isFresh(
    auth: SessionAuthState,
    method: VerifiedMethodRef,
    now: number,
    windowSeconds: number,
): boolean {
    const at = timeOf(auth.verified[method])
    if (at === null) return false
    if (at > now + MARK_CLOCK_SKEW_MS) return false
    return now - at <= windowSeconds * 1000
}

/**
 * The latest mark of any of `methods`, in ms, or null. With `now`, a mark more than
 * `MARK_CLOCK_SKEW_MS` in the future does not count (as in `isFresh`).
 */
export function latestMark(
    auth: SessionAuthState,
    methods: readonly VerifiedMethodRef[],
    now?: number,
): number | null {
    let latest: number | null = null
    for (const method of methods) {
        const at = timeOf(auth.verified[method])
        if (at === null) continue
        if (now !== undefined && at > now + MARK_CLOCK_SKEW_MS) continue
        if (latest === null || at > latest) latest = at
    }
    return latest
}

/** Whether the session is a recovery session that has not expired yet. */
export function isActiveRecovery(auth: SessionAuthState, now: number): boolean {
    if (auth.recovery === undefined) return false
    const expiresAt = timeOf(auth.recovery.expiresAt)
    return expiresAt !== null && now < expiresAt
}

/** `auth` with `method` proven at `at` (a step-up). */
export const withVerified = (
    auth: SessionAuthState,
    method: VerifiedMethodRef,
    at: string,
): SessionAuthState => ({ ...auth, verified: { ...auth.verified, [method]: at } })

/** `auth` of a recovery session that installed the new factor version `id` (state R+). */
export const withReplacementFactor = (
    auth: SessionAuthState,
    replacementFactor: NonNullable<RecoveryState['replacementFactor']>,
): SessionAuthState =>
    auth.recovery === undefined
        ? auth
        : { ...auth, recovery: { ...auth.recovery, replacementFactor } }

/**
 * Merges two states of the same session (Р2, updateSessionAuth): each freshness mark is the
 * later of both, and a recovery state removed in `current` is not brought back by `next`.
 */
export function mergeSessionAuth(
    current: SessionAuthState,
    next: SessionAuthState,
): SessionAuthState {
    const verified: Partial<Record<VerifiedMethodRef, string>> = { ...current.verified }
    for (const [method, at] of Object.entries(next.verified) as [VerifiedMethodRef, string][]) {
        const before = timeOf(verified[method])
        const after = timeOf(at)
        if (after !== null && (before === null || after > before)) verified[method] = at
    }
    const merged: SessionAuthState = {
        v: 1,
        amr: current.amr,
        aal: current.aal,
        authenticatedAt: current.authenticatedAt,
        verified,
    }
    if (current.recovery !== undefined && next.recovery !== undefined) {
        merged.recovery = {
            startedAt: current.recovery.startedAt,
            expiresAt: current.recovery.expiresAt,
            ...(next.recovery.replacementFactor !== undefined
                ? { replacementFactor: next.recovery.replacementFactor }
                : current.recovery.replacementFactor !== undefined
                  ? { replacementFactor: current.recovery.replacementFactor }
                  : {}),
        }
    }
    return merged
}
