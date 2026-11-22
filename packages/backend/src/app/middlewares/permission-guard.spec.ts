import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionAuthState, StaffFactorMode } from 'shared/mfa'

import type { HttpContext } from '#vendor/types/types.js'

const findRole = vi.fn()
vi.mock('#app/services/user/user-role-service.js', () => ({ userRoleService: { findRole } }))
const rememberActorRole = vi.fn()
vi.mock('#app/controllers/shared/audit-actor.js', () => ({ rememberActorRole }))

const mfaConfig = vi.hoisted(() => {
    const config: {
        requiredForStaff: boolean
        staffFactor: StaffFactorMode
        staffFactorMaxAgeHours: number
    } = {
        requiredForStaff: false,
        staffFactor: 'any',
        staffFactorMaxAgeHours: 12,
    }
    return config
})
vi.mock('#config/mfa.js', () => ({ default: mfaConfig }))
const loadMfaFactors = vi.fn()
vi.mock('#app/services/auth/mfa/mfa-account.js', () => ({ loadMfaFactors }))

const { permissionGuard } = await import('./permission-guard.js')

const context = (userId: string | null, auth?: SessionAuthState) =>
    ({
        auth: { getUserId: () => userId },
        session: { sessionInfo: { data: auth === undefined ? {} : { auth } } },
        responseData: { status: 200, payload: null },
    }) as unknown as HttpContext

afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mfaConfig.requiredForStaff = false
    mfaConfig.staffFactor = 'any'
})

describe('can:<permission> (feat-240)', () => {
    it.each([
        ['an anonymous request', null, undefined],
        ['a user', '7', 'user'],
        ['a deleted user', '7', undefined],
        ['a role without the permission', '7', 'support_operator'],
    ])('answers the canonical 403 for %s', async (_name, userId, role) => {
        findRole.mockResolvedValue(role)
        const ctx = context(userId)
        const next = vi.fn()

        await permissionGuard('kb.write')(ctx, next)

        expect(next).not.toHaveBeenCalled()
        expect(rememberActorRole).not.toHaveBeenCalled()
        expect(ctx.responseData.status).toBe(403)
        expect(ctx.responseData.payload).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
    })

    it.each([['kb_editor'], ['admin']])(
        'lets %s through and remembers the role it read',
        async (role) => {
            findRole.mockResolvedValue(role)
            const ctx = context('7')
            const next = vi.fn(async () => {})

            await permissionGuard('kb.write')(ctx, next)

            expect(findRole).toHaveBeenCalledWith(7n)
            expect(rememberActorRole).toHaveBeenCalledWith(ctx, role)
            expect(next).toHaveBeenCalledOnce()
            expect(ctx.responseData.status).toBe(200)
        },
    )
})

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): a staff role with MFA_REQUIRED_FOR_STAFF on.
describe('can:<permission> with the staff MFA rule (feat-247)', () => {
    const NOW = Date.parse('2026-11-22T12:00:00.000Z')
    const HOUR = 3_600_000
    const at = (ms: number): string => new Date(ms).toISOString()
    const aal2 = (verifiedAt: number): SessionAuthState => ({
        v: 1,
        amr: ['pwd', 'otp'],
        aal: 2,
        authenticatedAt: at(verifiedAt),
        verified: { otp: at(verifiedAt), pwd: at(verifiedAt) },
    })
    const enrolled = { totp: { id: 1n }, passkeys: 0 }

    const run = async (auth: SessionAuthState | undefined) => {
        findRole.mockResolvedValue('admin')
        const ctx = context('7', auth)
        const next = vi.fn(async () => {})
        await permissionGuard('users.read')(ctx, next)
        return { ctx, next }
    }

    const refusedWith = (ctx: HttpContext, reason: string): void => {
        expect(ctx.responseData.status).toBe(403)
        expect(ctx.responseData.payload).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
            reason,
        })
    }

    it.each<[string, SessionAuthState | undefined]>([
        [
            'an AAL1 session',
            { v: 1, amr: ['pwd'], aal: 1, authenticatedAt: at(NOW), verified: { pwd: at(NOW) } },
        ],
        ['a session stored before feat-245', undefined],
        ['a proof older than 12 h', aal2(NOW - 12 * HOUR - 1)],
        [
            'a recovery session',
            {
                ...aal2(NOW),
                recovery: { startedAt: at(NOW), expiresAt: at(NOW + HOUR / 4) },
            },
        ],
    ])('an enrolled admin with %s: 403 mfa_session_required', async (_name, auth) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW)
        mfaConfig.requiredForStaff = true
        loadMfaFactors.mockResolvedValue(enrolled)
        const { ctx, next } = await run(auth)
        expect(next).not.toHaveBeenCalled()
        refusedWith(ctx, 'mfa_session_required')
    })

    it('an admin without TOTP or a passkey: 403 mfa_required', async () => {
        mfaConfig.requiredForStaff = true
        loadMfaFactors.mockResolvedValue({ totp: undefined, passkeys: 0 })
        const { ctx, next } = await run(aal2(Date.now()))
        expect(loadMfaFactors).toHaveBeenCalledWith(7n)
        expect(next).not.toHaveBeenCalled()
        refusedWith(ctx, 'mfa_required')
    })

    it.each([
        ['TOTP', enrolled],
        ['a passkey', { totp: undefined, passkeys: 1 }],
    ])('an admin with %s and a fresh AAL2 session passes', async (_name, factors) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW)
        mfaConfig.requiredForStaff = true
        loadMfaFactors.mockResolvedValue(factors)
        const { ctx, next } = await run(aal2(NOW - 11 * HOUR))
        expect(next).toHaveBeenCalledOnce()
        expect(ctx.responseData.status).toBe(200)
    })

    it('with the rule off nothing changes: no factors read, an AAL1 session passes', async () => {
        loadMfaFactors.mockResolvedValue({ totp: undefined, passkeys: 0 })
        const { ctx, next } = await run(undefined)
        expect(loadMfaFactors).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledOnce()
        expect(ctx.responseData.status).toBe(200)
    })

    it('a role without the permission keeps the canonical 403 without a reason', async () => {
        mfaConfig.requiredForStaff = true
        findRole.mockResolvedValue('kb_editor')
        const ctx = context('7')
        await permissionGuard('users.read')(ctx, vi.fn())
        expect(loadMfaFactors).not.toHaveBeenCalled()
        expect(ctx.responseData.payload).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
    })
})

// feat-248 (Р10, Д11): the same guard, the same table, in both modes of MFA_STAFF_FACTOR.
describe('can:<permission> in both staff factor modes (feat-248)', () => {
    const NOW = Date.parse('2026-11-22T12:00:00.000Z')
    const HOUR = 3_600_000
    const at = (ms: number): string => new Date(ms).toISOString()
    const totpSignIn: SessionAuthState = {
        v: 1,
        amr: ['pwd', 'otp'],
        aal: 2,
        authenticatedAt: at(NOW - HOUR),
        verified: { pwd: at(NOW - HOUR), otp: at(NOW - HOUR) },
    }
    const passkeySignIn: SessionAuthState = {
        v: 1,
        amr: ['webauthn'],
        aal: 2,
        authenticatedAt: at(NOW - HOUR),
        verified: { webauthn: at(NOW - HOUR) },
    }
    const totpWithPasskeyStepUp: SessionAuthState = {
        ...totpSignIn,
        verified: { ...totpSignIn.verified, webauthn: at(NOW - 60_000) },
    }
    const TOTP_ONLY = { totp: { id: 1n }, passkeys: 0 }
    const PASSKEY_ONLY = { totp: undefined, passkeys: 1 }
    const BOTH = { totp: { id: 1n }, passkeys: 1 }

    // [factors, session, any, passkey]: null lets the request through.
    const TABLE: [
        string,
        typeof BOTH | typeof PASSKEY_ONLY,
        SessionAuthState,
        string | null,
        string | null,
    ][] = [
        ['TOTP only, TOTP sign-in', TOTP_ONLY, totpSignIn, null, 'mfa_required'],
        ['passkey only, passkey sign-in', PASSKEY_ONLY, passkeySignIn, null, null],
        ['both, TOTP sign-in', BOTH, totpSignIn, null, 'mfa_session_required'],
        [
            'both, TOTP sign-in with a passkey step-up',
            BOTH,
            totpWithPasskeyStepUp,
            null,
            'mfa_session_required',
        ],
        ['both, passkey sign-in', BOTH, passkeySignIn, null, null],
        [
            'both, passkey sign-in older than 12 h',
            BOTH,
            { ...passkeySignIn, verified: { webauthn: at(NOW - 12 * HOUR - 1) } },
            'mfa_session_required',
            'mfa_session_required',
        ],
    ]

    describe.each([
        ['any', 3],
        ['passkey', 4],
    ] as const)('MFA_STAFF_FACTOR=%s', (mode, column) => {
        it.each(TABLE)('%s', async (...row) => {
            const [, factors, auth] = row
            const expected = row[column]
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(NOW)
            mfaConfig.requiredForStaff = true
            mfaConfig.staffFactor = mode
            loadMfaFactors.mockResolvedValue(factors)
            findRole.mockResolvedValue('admin')
            const ctx = context('7', auth)
            const next = vi.fn(async () => {})
            await permissionGuard('users.read')(ctx, next)
            if (expected === null) {
                expect(next).toHaveBeenCalledOnce()
                expect(ctx.responseData.status).toBe(200)
            } else {
                expect(next).not.toHaveBeenCalled()
                expect(ctx.responseData.status).toBe(403)
                expect(ctx.responseData.payload).toEqual({
                    status: 'error',
                    code: 'forbidden',
                    message: 'Access denied',
                    reason: expected,
                })
            }
        })
    })
})
