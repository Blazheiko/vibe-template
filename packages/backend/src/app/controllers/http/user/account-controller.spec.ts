import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-232: the controller hands the request's own session checks to the service: the token it
// presented and `session.isStored`, as the password change does (feat-129).

const { getProfile, updateProfile } = vi.hoisted(() => ({
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
}))
vi.mock('#app/services/user/account-service.js', () => ({
    accountService: { getProfile, updateProfile },
}))
const findRole = vi.hoisted(() => vi.fn())
vi.mock('#app/services/user/user-role-service.js', () => ({ userRoleService: { findRole } }))

const { default: AccountController } = await import('./account-controller.js')

const profile = {
    name: 'Ann',
    preferences: { locale: null, timeZone: null, theme: 'dark', colorTheme: null, fontSize: null },
    revision: '3',
}

const createContext = (stored: boolean, signedIn = true) => {
    const isStored = vi.fn(() => Promise.resolve(stored))
    const context = {
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
        httpData: { ip: '203.0.113.7', payload: { theme: 'dark' } },
        responseData: { status: 200 },
        auth: {
            check: () => signedIn,
            getUserId: () => (signedIn ? '7' : null),
            getPresentedUserToken: () => 'presented-token',
        },
        session: { sessionInfo: { id: 's1', data: { userId: '7' } }, isStored },
        signal: new AbortController().signal,
    } as never
    return { context, isStored }
}

beforeEach(() => {
    vi.clearAllMocks()
    getProfile.mockResolvedValue(Result.ok(profile))
    updateProfile.mockResolvedValue(Result.ok(profile))
})

describe('AccountController', () => {
    it('getProfile answers the profile of the signed-in user', async () => {
        const { context } = createContext(true)

        await expect(AccountController.getProfile(context)).resolves.toEqual({
            status: 'success',
            profile,
        })
        expect(getProfile).toHaveBeenCalledWith(7n)
    })

    it('updateProfile hands over the payload, the presented token and the stored check', async () => {
        for (const stored of [false, true]) {
            updateProfile.mockClear()
            const { context, isStored } = createContext(stored)

            await AccountController.updateProfile(context)

            expect(updateProfile).toHaveBeenCalledOnce()
            const [userId, body, token, guard] = updateProfile.mock.calls[0] as [
                bigint,
                unknown,
                string,
                () => Promise<boolean>,
            ]
            expect(userId).toBe(7n)
            expect(body).toEqual({ theme: 'dark' })
            expect(token).toBe('presented-token')
            expect(isStored).not.toHaveBeenCalled()
            await expect(guard()).resolves.toBe(stored)
        }
    })

    it('an error of the service becomes its canonical answer', async () => {
        updateProfile.mockResolvedValue(
            Result.err({ _tag: 'RateLimited', message: 'Too many profile changes.' }),
        )
        const { context } = createContext(true)

        const reply = await AccountController.updateProfile(context)

        expect(reply).toMatchObject({ status: 'error', code: 'rate_limited' })
        expect((context as { responseData: { status: number } }).responseData.status).toBe(429)
    })

    // feat-240 (Р8): the role a tab reads again on reconnect and when it is shown.
    it('getAccess answers the role of the signed-in user from the database', async () => {
        findRole.mockResolvedValue('kb_editor')
        const { context } = createContext(true)

        await expect(AccountController.getAccess(context)).resolves.toEqual({
            status: 'success',
            role: 'kb_editor',
        })
        expect(findRole).toHaveBeenCalledWith(7n)
    })

    it('getAccess answers 401 without a user and 404 for a user that is gone', async () => {
        const anonymous = createContext(true, false).context as { responseData: { status: number } }
        await AccountController.getAccess(anonymous as never)
        expect(anonymous.responseData.status).toBe(401)

        findRole.mockResolvedValue(undefined)
        const gone = createContext(true).context as { responseData: { status: number } }
        await AccountController.getAccess(gone as never)
        expect(gone.responseData.status).toBe(404)
    })
})
