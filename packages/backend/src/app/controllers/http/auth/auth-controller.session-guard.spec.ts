import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-129 (fifth review L5): a logout in another tab deletes the session record without rotating
// users.session_token, so the services ask right before a mail, an SMS or a link whether the
// record is still there. These cases pin the wiring: the guard each controller hands over is the
// request's own `session.isStored`, not a stand-in that always says yes.

const { startPhoneLink, confirmPhoneLink, startEmailLink, queueVerificationEmail } = vi.hoisted(
    () => ({
        startPhoneLink: vi.fn(),
        confirmPhoneLink: vi.fn(),
        startEmailLink: vi.fn(),
        queueVerificationEmail: vi.fn(),
    }),
)

vi.mock('#app/services/auth/auth-service.js', () => ({
    authService: { startPhoneLink, confirmPhoneLink, startEmailLink },
}))
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: { queueVerificationEmail },
}))
vi.mock('#app/services/auth/password-reset-service.js', () => ({
    passwordResetService: {},
    GENERIC_RESET_MESSAGE: '',
}))

const { default: AuthController } = await import('./auth-controller.js')

type Guard = () => Promise<boolean>

const createContext = (stored: boolean) => {
    const isStored = vi.fn(() => Promise.resolve(stored))
    const context = {
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
        httpData: { ip: '203.0.113.7', payload: {} },
        responseData: { status: 200 },
        auth: {
            check: () => true,
            getUserId: () => '7',
            getPresentedUserToken: () => 'presented-token',
        },
        session: { sessionInfo: { id: 's1', data: { userId: '7' } }, isStored },
        signal: new AbortController().signal,
    } as never
    return { context, isStored }
}

const ok = Result.ok({ status: 'success', message: 'ok' })

const cases: {
    name: string
    service: ReturnType<typeof vi.fn>
    run: (context: never) => Promise<unknown>
    guardOf: (call: unknown[]) => Guard
}[] = [
    {
        name: 'startPhoneLink',
        service: startPhoneLink,
        run: (context) => AuthController.startPhoneLink(context),
        guardOf: (call) => (call[2] as { sessionStored: Guard }).sessionStored,
    },
    {
        name: 'confirmPhoneLink',
        service: confirmPhoneLink,
        run: (context) => AuthController.confirmPhoneLink(context),
        guardOf: (call) => (call[2] as { sessionStored: Guard }).sessionStored,
    },
    {
        name: 'startEmailLink',
        service: startEmailLink,
        run: (context) => AuthController.startEmailLink(context),
        guardOf: (call) => call[3] as Guard,
    },
    {
        name: 'resendVerificationEmail',
        service: queueVerificationEmail,
        run: (context) => AuthController.resendVerificationEmail(context),
        guardOf: (call) => call[1] as Guard,
    },
]

describe('AuthController session-still-stored guard (feat-129)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        for (const { service } of cases) service.mockResolvedValue(ok)
    })

    it.each(cases)('$name hands over the request session check', async (row) => {
        for (const stored of [false, true]) {
            row.service.mockClear()
            const { context, isStored } = createContext(stored)

            await row.run(context)

            expect(row.service).toHaveBeenCalledOnce()
            const guard = row.guardOf(row.service.mock.calls[0]!)
            expect(isStored).not.toHaveBeenCalled()
            await expect(guard()).resolves.toBe(stored)
            expect(isStored).toHaveBeenCalledOnce()
        }
    })
})
