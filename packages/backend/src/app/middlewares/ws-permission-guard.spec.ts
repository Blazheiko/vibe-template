import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionAuthState, StaffFactorMode } from 'shared/mfa'

import type { WsContext } from '#vendor/types/types.js'

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

const { wsPermissionGuard } = await import('./ws-permission-guard.js')

const wsContext = (userData: Record<string, unknown> | null) => ({
    userData,
    responseData: { status: '200', data: null, error: null, event: 'admin/x', timestamp: 0 },
    logger: { error: vi.fn() },
    signal: new AbortController().signal,
})

describe('ws_can:<permission> (feat-240)', () => {
    it.each([
        ['no user data', null],
        ['a user', { role: 'user' }],
        ['a role without the permission', { role: 'kb_editor' }],
        ['a paused admin channel', { role: 'admin', adminChannelPaused: true }],
    ])('answers 403 for %s and skips the handler', async (_name, userData) => {
        const context = wsContext(userData)
        const next = vi.fn()

        await wsPermissionGuard('users.read')(context as unknown as WsContext, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe('403')
        expect(context.responseData.data).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
    })

    it.each([['support_operator'], ['user_admin'], ['admin']])('lets %s through', async (role) => {
        const context = wsContext({ role, adminChannelPaused: false })
        const next = vi.fn(async () => {})

        await wsPermissionGuard('users.read')(context as unknown as WsContext, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe('200')
    })
})

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the staff rule, checked with the current time.
describe('ws_can:<permission> with the staff MFA rule (feat-247)', () => {
    const NOW = Date.parse('2026-11-22T12:00:00.000Z')
    const HOUR = 3_600_000
    const at = (ms: number): string => new Date(ms).toISOString()
    const aal2 = (verifiedAt: number): SessionAuthState => ({
        v: 1,
        amr: ['pwd', 'otp'],
        aal: 2,
        authenticatedAt: at(verifiedAt),
        verified: { otp: at(verifiedAt) },
    })

    afterEach(() => {
        vi.useRealTimers()
        mfaConfig.requiredForStaff = false
    })

    const run = async (auth: SessionAuthState | undefined) => {
        const context = wsContext({ role: 'admin', ...(auth === undefined ? {} : { auth }) })
        const next = vi.fn(async () => {})
        await wsPermissionGuard('users.read')(context as unknown as WsContext, next)
        return { context, next }
    }

    it.each<[string, SessionAuthState | undefined]>([
        ['no auth (as AAL1)', undefined],
        ['AAL1', { v: 1, amr: ['pwd'], aal: 1, authenticatedAt: at(NOW), verified: {} }],
        ['a proof older than 12 h', aal2(NOW - 12 * HOUR)],
    ])('refuses %s with mfa_session_required', async (_name, auth) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW)
        mfaConfig.requiredForStaff = true
        const { context, next } = await run(auth)
        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe('403')
        expect(context.responseData.data).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
            reason: 'mfa_session_required',
        })
    })

    it('lets a fresh AAL2 staff session through, and refuses it once the clock passes 12 h', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW)
        mfaConfig.requiredForStaff = true
        const auth = aal2(NOW)
        expect((await run(auth)).next).toHaveBeenCalledOnce()
        vi.setSystemTime(NOW + 12 * HOUR)
        expect((await run(auth)).next).not.toHaveBeenCalled()
    })

    it('with the rule off an AAL1 staff session passes as before', async () => {
        expect((await run(undefined)).next).toHaveBeenCalledOnce()
    })
})

// feat-248 (Р11, Д11): the same check per message in both modes of MFA_STAFF_FACTOR.
describe('ws_can:<permission> in both staff factor modes (feat-248)', () => {
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

    afterEach(() => {
        vi.useRealTimers()
        mfaConfig.requiredForStaff = false
        mfaConfig.staffFactor = 'any'
    })

    // [session, passes with any, passes with passkey]
    const TABLE: [string, SessionAuthState, boolean, boolean][] = [
        ['a TOTP sign-in', totpSignIn, true, false],
        [
            'a TOTP sign-in with a passkey step-up',
            { ...totpSignIn, verified: { ...totpSignIn.verified, webauthn: at(NOW - 1000) } },
            true,
            false,
        ],
        ['a passkey sign-in', passkeySignIn, true, true],
        [
            'a passkey sign-in older than 12 h',
            { ...passkeySignIn, verified: { webauthn: at(NOW - 12 * HOUR) } },
            false,
            false,
        ],
    ]

    describe.each([
        ['any', 2],
        ['passkey', 3],
    ] as const)('MFA_STAFF_FACTOR=%s', (mode, column) => {
        it.each(TABLE)('%s', async (...row) => {
            const auth = row[1]
            const passes = row[column]
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(NOW)
            mfaConfig.requiredForStaff = true
            mfaConfig.staffFactor = mode
            const context = wsContext({ role: 'admin', auth })
            const next = vi.fn(async () => {})
            await wsPermissionGuard('users.read')(context as unknown as WsContext, next)
            if (passes) {
                expect(next).toHaveBeenCalledOnce()
            } else {
                expect(next).not.toHaveBeenCalled()
                expect(context.responseData.data).toEqual({
                    status: 'error',
                    code: 'forbidden',
                    message: 'Access denied',
                    reason: 'mfa_session_required',
                })
            }
        })
    })
})
