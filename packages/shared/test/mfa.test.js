import { test } from 'node:test'
import assert from 'node:assert/strict'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р2, Р3, Р10): the proof matrix, the staff policy and
// the session auth state. Expectations are written out here, not derived from the catalog.
const {
    PROOF_ACTIONS,
    proofDecision,
    stepUpProofsOf,
    mergeSessionAuth,
    withVerified,
    withReplacementFactor,
    isFresh,
    staffMfaPolicy,
    staffSessionOk,
    MFA_REASONS,
    LEGACY_SESSION_AUTH,
} = await import('../dist/mfa/index.js')

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString()
const later = (seconds) => new Date(NOW + seconds * 1000).toISOString()

const session = (verified = {}, extra = {}) => ({
    v: 1,
    amr: ['pwd'],
    aal: 1,
    authenticatedAt: ago(3600),
    verified,
    ...extra,
})

const NO_MFA_PASSWORD = { hasPassword: true, totp: false, passkeys: 0 }
const NO_MFA_OAUTH_ONLY = { hasPassword: false, totp: false, passkeys: 0 }
const TOTP = { hasPassword: true, totp: true, passkeys: 0 }
const TOTP_AND_PASSKEY = { hasPassword: true, totp: true, passkeys: 1 }
const PASSKEY_ONLY = { hasPassword: false, totp: false, passkeys: 2 }

const decide = (action, account, auth, extra = {}) =>
    proofDecision({ action, account, auth, now: NOW, ...extra })

test('without MFA: a fresh password allows rows 1, 6, 7, 8, 9, 10; a stale one asks for it', () => {
    for (const action of [
        'mfa.add_factor',
        'password.change',
        'contact.link',
        'oauth.unlink',
        'role.assign',
        'mfa.reset_other',
    ]) {
        assert.deepEqual(decide(action, NO_MFA_PASSWORD, session({ pwd: ago(60) })), { kind: 'ok' })
        assert.deepEqual(decide(action, NO_MFA_PASSWORD, session({ pwd: ago(301) })), {
            kind: 'reauth_required',
            proofs: ['password'],
        })
        assert.deepEqual(decide(action, NO_MFA_PASSWORD, session({})), {
            kind: 'reauth_required',
            proofs: ['password'],
        })
    }
})

test('without MFA and without a password: only a recent OAuth sign-in counts', () => {
    assert.deepEqual(decide('password.change', NO_MFA_OAUTH_ONLY, session({ oauth: ago(599) })), {
        kind: 'ok',
    })
    assert.deepEqual(decide('password.change', NO_MFA_OAUTH_ONLY, session({ oauth: ago(601) })), {
        kind: 'sign_in_again_required',
    })
    // A password mark means nothing for an account that has no password.
    assert.deepEqual(decide('contact.link', NO_MFA_OAUTH_ONLY, session({ pwd: ago(1) })), {
        kind: 'sign_in_again_required',
    })
})

test('without MFA: removing a factor or regenerating codes is not a row that applies', () => {
    for (const action of ['mfa.remove_factor', 'mfa.regenerate_codes']) {
        assert.deepEqual(decide(action, NO_MFA_PASSWORD, session({ pwd: ago(1) })), {
            kind: 'sign_in_again_required',
        })
    }
})

test('with MFA: the password alone proves nothing; a fresh factor does', () => {
    for (const action of PROOF_ACTIONS) {
        assert.deepEqual(decide(action, TOTP, session({ pwd: ago(1) })), {
            kind: 'reauth_required',
            proofs: ['totp'],
        })
        assert.deepEqual(decide(action, TOTP, session({ otp: ago(10) })), { kind: 'ok' })
        assert.deepEqual(decide(action, TOTP, session({ otp: ago(301) })), {
            kind: 'reauth_required',
            proofs: ['totp'],
        })
    }
    assert.deepEqual(decide('password.change', TOTP_AND_PASSKEY, session({})), {
        kind: 'reauth_required',
        proofs: ['totp', 'webauthn'],
    })
    assert.deepEqual(decide('password.change', TOTP_AND_PASSKEY, session({ webauthn: ago(5) })), {
        kind: 'ok',
    })
    assert.deepEqual(decide('oauth.unlink', PASSKEY_ONLY, session({})), {
        kind: 'reauth_required',
        proofs: ['webauthn'],
    })
})

test('rows 9–10 accept only the proofs of the staff policy', () => {
    const passkeyOnlyStaff = { staffStepUpProofs: ['webauthn'] }
    assert.deepEqual(
        decide('role.assign', TOTP_AND_PASSKEY, session({ otp: ago(5) }), passkeyOnlyStaff),
        { kind: 'reauth_required', proofs: ['webauthn'] },
    )
    assert.deepEqual(decide('role.assign', TOTP, session({ otp: ago(5) }), passkeyOnlyStaff), {
        kind: 'sign_in_again_required',
    })
    // Other rows ignore it.
    assert.deepEqual(
        decide('password.change', TOTP_AND_PASSKEY, session({ otp: ago(5) }), passkeyOnlyStaff),
        { kind: 'ok' },
    )
})

test('a recovery session: add a factor in R, remove and regenerate only in R+', () => {
    const recovery = { startedAt: ago(60), expiresAt: later(840) }
    const r = session({ pwd: ago(60) }, { amr: ['pwd', 'recovery'], recovery })
    const rPlus = withReplacementFactor(r, { kind: 'totp', id: '7', at: ago(10) })
    assert.deepEqual(decide('mfa.add_factor', TOTP, r), { kind: 'ok' })
    assert.deepEqual(decide('mfa.remove_factor', TOTP, r), { kind: 'recovery_session' })
    assert.deepEqual(decide('mfa.regenerate_codes', TOTP, r), { kind: 'recovery_session' })
    assert.deepEqual(decide('mfa.remove_factor', TOTP, rPlus), { kind: 'ok' })
    assert.deepEqual(decide('mfa.regenerate_codes', TOTP, rPlus), { kind: 'ok' })
    for (const action of [
        'password.change',
        'contact.link',
        'oauth.unlink',
        'role.assign',
        'mfa.reset_other',
    ]) {
        // A recovery code is never a step-up, even with a fresh factor mark.
        assert.deepEqual(decide(action, TOTP, withVerified(rPlus, 'otp', ago(1))), {
            kind: 'recovery_session',
        })
    }
    const expired = session({}, { recovery: { startedAt: ago(1000), expiresAt: ago(100) } })
    assert.deepEqual(decide('mfa.add_factor', TOTP, expired), { kind: 'recovery_session' })
})

test('a session stored before feat-245 has nothing fresh', () => {
    assert.equal(LEGACY_SESSION_AUTH.aal, 1)
    assert.deepEqual(decide('password.change', NO_MFA_PASSWORD, undefined), {
        kind: 'reauth_required',
        proofs: ['password'],
    })
})

test('a mark from the future counts only up to a minute ahead', () => {
    assert.equal(isFresh(session({ pwd: later(30) }), 'pwd', NOW, 300), true)
    assert.equal(isFresh(session({ pwd: later(120) }), 'pwd', NOW, 300), false)
    assert.equal(isFresh(session({ pwd: 'not a date' }), 'pwd', NOW, 300), false)
})

test('the step-up proofs of an account', () => {
    assert.deepEqual(stepUpProofsOf(NO_MFA_PASSWORD), ['password'])
    assert.deepEqual(stepUpProofsOf(NO_MFA_OAUTH_ONLY), [])
    assert.deepEqual(stepUpProofsOf(TOTP), ['totp'])
    assert.deepEqual(stepUpProofsOf(TOTP_AND_PASSKEY), ['totp', 'webauthn'])
})

test('merging keeps the later mark of each method and never brings recovery back', () => {
    const current = session({ pwd: ago(100), otp: ago(10) })
    const next = session({ pwd: ago(5), otp: ago(50), webauthn: ago(1) })
    const merged = mergeSessionAuth(current, next)
    assert.deepEqual(merged.verified, { pwd: ago(5), otp: ago(10), webauthn: ago(1) })
    assert.equal(merged.aal, current.aal)

    const withRecovery = session({}, { recovery: { startedAt: ago(1), expiresAt: later(899) } })
    assert.equal(mergeSessionAuth(session({}), withRecovery).recovery, undefined)
    // The level and the sign-in methods of the session never change.
    assert.equal(mergeSessionAuth(current, { ...next, aal: 2, amr: ['otp'] }).aal, 1)
})

test('staff policy any: the factor, the session level, the age and recovery', () => {
    const policy = staffMfaPolicy('any')
    assert.equal(policy.enrolled({ totp: true, passkeys: 0 }), true)
    assert.equal(policy.enrolled({ totp: false, passkeys: 1 }), true)
    assert.equal(policy.enrolled({ totp: false, passkeys: 0 }), false)
    assert.deepEqual(policy.stepUpProofs, ['totp', 'webauthn'])

    const aal2 = session({ otp: ago(3600) }, { aal: 2, amr: ['pwd', 'otp'] })
    assert.equal(staffSessionOk(policy, aal2, NOW, 12), true)
    assert.equal(policy.sessionDeadline(aal2, NOW, 12), NOW - 3600_000 + 12 * 3600_000)
    // AAL1 with a fresh factor mark (a step-up) is still not enough.
    assert.equal(staffSessionOk(policy, session({ otp: ago(1) }), NOW, 12), false)
    assert.equal(
        staffSessionOk(policy, { ...aal2, verified: { otp: ago(13 * 3600) } }, NOW, 12),
        false,
    )
    assert.equal(
        staffSessionOk(
            policy,
            { ...aal2, recovery: { startedAt: ago(1), expiresAt: later(1) } },
            NOW,
            12,
        ),
        false,
    )
    assert.equal(staffSessionOk(policy, undefined, NOW, 12), false)
})

test('staff policy passkey: a passkey, a passkey sign-in and a fresh passkey mark', () => {
    const policy = staffMfaPolicy('passkey')
    assert.equal(policy.mode, 'passkey')
    assert.equal(policy.enrolled({ totp: true, passkeys: 0 }), false)
    assert.equal(policy.enrolled({ totp: false, passkeys: 1 }), true)
    assert.equal(policy.enrolled({ totp: true, passkeys: 2 }), true)
    assert.deepEqual(policy.stepUpProofs, ['webauthn'])

    const passkeySignIn = session({ webauthn: ago(3600) }, { aal: 2, amr: ['webauthn'] })
    assert.equal(staffSessionOk(policy, passkeySignIn, NOW, 12), true)
    assert.equal(policy.sessionDeadline(passkeySignIn, NOW, 12), NOW - 3600_000 + 12 * 3600_000)
    // A passkey step-up moves the deadline of a passkey session.
    assert.equal(
        policy.sessionDeadline(withVerified(passkeySignIn, 'webauthn', ago(10)), NOW, 12),
        NOW - 10_000 + 12 * 3600_000,
    )
    // Signed in with TOTP: a passkey step-up does not make it a passkey session.
    const totpSignIn = session({ pwd: ago(60), otp: ago(60) }, { aal: 2, amr: ['pwd', 'otp'] })
    assert.equal(
        staffSessionOk(policy, withVerified(totpSignIn, 'webauthn', ago(5)), NOW, 12),
        false,
    )
    // A fresh TOTP mark does not refresh a passkey session either.
    const stale = { ...passkeySignIn, verified: { webauthn: ago(13 * 3600), otp: ago(5) } }
    assert.equal(staffSessionOk(policy, stale, NOW, 12), false)
    assert.equal(
        staffSessionOk(
            policy,
            { ...passkeySignIn, recovery: { startedAt: ago(1), expiresAt: later(1) } },
            NOW,
            12,
        ),
        false,
    )
    assert.equal(staffSessionOk(policy, undefined, NOW, 12), false)
})

test('staff policy: the table of both modes', () => {
    const totpSignIn = session({ pwd: ago(60), otp: ago(60) }, { aal: 2, amr: ['pwd', 'otp'] })
    const passkeySignIn = session({ webauthn: ago(60) }, { aal: 2, amr: ['webauthn'] })
    const passwordOnly = session({ pwd: ago(60) })
    const rows = [
        // [session, any, passkey]
        [totpSignIn, true, false],
        [withVerified(totpSignIn, 'webauthn', ago(5)), true, false],
        [passkeySignIn, true, true],
        [withVerified(passwordOnly, 'webauthn', ago(5)), false, false],
        [withVerified(passwordOnly, 'otp', ago(5)), false, false],
        [{ ...passkeySignIn, verified: { webauthn: ago(13 * 3600) } }, false, false],
        [{ ...totpSignIn, verified: { otp: ago(13 * 3600) } }, false, false],
    ]
    for (const [auth, any, passkey] of rows) {
        assert.equal(staffSessionOk(staffMfaPolicy('any'), auth, NOW, 12), any)
        assert.equal(staffSessionOk(staffMfaPolicy('passkey'), auth, NOW, 12), passkey)
    }
    const factors = [
        // [factors, any, passkey]
        [{ totp: false, passkeys: 0 }, false, false],
        [{ totp: true, passkeys: 0 }, true, false],
        [{ totp: false, passkeys: 1 }, true, true],
        [{ totp: true, passkeys: 1 }, true, true],
    ]
    for (const [account, any, passkey] of factors) {
        assert.equal(staffMfaPolicy('any').enrolled(account), any)
        assert.equal(staffMfaPolicy('passkey').enrolled(account), passkey)
    }
    // Rows 9–10 with the passkey policy: a TOTP step-up is not accepted.
    const staffStepUpProofs = staffMfaPolicy('passkey').stepUpProofs
    assert.deepEqual(
        decide('role.assign', TOTP_AND_PASSKEY, session({ otp: ago(5) }), { staffStepUpProofs }),
        { kind: 'reauth_required', proofs: ['webauthn'] },
    )
    assert.deepEqual(
        decide('role.assign', TOTP_AND_PASSKEY, session({ webauthn: ago(5) }), {
            staffStepUpProofs,
        }),
        { kind: 'ok' },
    )
})

test('MFA reasons are unique snake_case strings', () => {
    const values = Object.values(MFA_REASONS)
    assert.equal(new Set(values).size, values.length)
    for (const value of values) assert.match(value, /^[a-z][a-z_]*$/)
})
