import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// feat-076 (J): what every auth form does around a request, and what a sign-in does, once.

const t = (key: string): string => `t:${key}`
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t }) }))

const push = vi.hoisted(() => vi.fn())
const route = vi.hoisted(() => {
    const current: { query: Record<string, unknown> } = { query: {} }
    return current
})
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => route }))

const calls: string[] = []
const setUser = vi.hoisted(() => vi.fn())
vi.mock('@/stores/user', () => ({ useUserStore: () => ({ setUser }) }))
const emit = vi.hoisted(() => vi.fn())
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit }) }))

describe('useAuthRequest', () => {
    it('keeps the loading flag on while the request runs and off after it', async () => {
        const { useAuthRequest } = await import('../useAuthRequest')
        const { runAuthRequest } = useAuthRequest()
        const loading = ref(false)
        const error = ref('')
        let during = false
        await runAuthRequest(loading, error, 'Thing', () => {
            during = loading.value
            return Promise.resolve()
        })
        expect(during).toBe(true)
        expect(loading.value).toBe(false)
        expect(error.value).toBe('')
    })

    it('says "server error" and logs what happened when the request throws, and still turns loading off', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const { useAuthRequest } = await import('../useAuthRequest')
        const { runAuthRequest } = useAuthRequest()
        const loading = ref(false)
        const error = ref('')
        const boom = new Error('boom')
        await runAuthRequest(loading, error, 'Phone registration start', () => Promise.reject(boom))
        expect(error.value).toBe('t:auth.errorServer')
        expect(loading.value).toBe(false)
        expect(log).toHaveBeenCalledWith('Phone registration start failed:', boom)
        log.mockRestore()
    })

    it('failureMessage is null for an answer that is not an error, and the message for one that is', async () => {
        const { useAuthRequest } = await import('../useAuthRequest')
        const { failureMessage } = useAuthRequest()
        expect(failureMessage({ status: 'success' }, null)).toBeNull()
        expect(failureMessage(null, { message: 'Network down' })).toBe('Network down')
        expect(failureMessage(null, {})).toBe('t:auth.errorServer')
        expect(
            failureMessage({ status: 'error', code: 'bad_request', message: 'Refused' }, null),
        ).toBe('Refused')
    })
})

describe('useCompleteSignIn', () => {
    const signIn = async (): Promise<void> => {
        const { useCompleteSignIn } = await import('../useCompleteSignIn')
        useCompleteSignIn(() => calls.push('onSignedIn'))({ id: '1' })
        await Promise.resolve()
        await Promise.resolve()
    }

    beforeEach(() => {
        calls.length = 0
        vi.clearAllMocks()
        route.query = {}
        sessionStorage.clear()
        setUser.mockImplementation(() => calls.push('setUser'))
        push.mockImplementation(() => {
            calls.push('push')
            return Promise.resolve()
        })
        emit.mockImplementation(() => calls.push('init_app'))
    })

    it('remembers the user, tells the caller, opens the account page, then has the app read the session — in that order', async () => {
        await signIn()

        expect(calls).toEqual(['setUser', 'onSignedIn', 'push', 'init_app'])
        expect(setUser).toHaveBeenCalledWith({ id: '1' })
        expect(push).toHaveBeenCalledWith({ name: 'UserAccount' })
        expect(emit).toHaveBeenCalledWith('init_app')
    })

    // feat-154 (review 2026-11-10, M10): the router guard sends an anonymous visitor to
    // /login?redirect=<where they were going>. Closing the modal replaces the route, so the
    // target is read first.
    it('goes to the page the router guard remembered in ?redirect=', async () => {
        route.query = { redirect: '/support' }
        await signIn()

        expect(push).toHaveBeenCalledWith('/support')
    })

    it.each(['https://evil.example/', '//evil.example', '/\\evil.example', 'support', ''])(
        'ignores a redirect that is not a path inside the application: %s',
        async (redirect) => {
            route.query = { redirect }
            await signIn()

            expect(push).toHaveBeenCalledWith({ name: 'UserAccount' })
        },
    )

    it('has the app read the session only after the navigation settled, so init sees the new page', async () => {
        let finishNavigation: (() => void) | undefined
        push.mockImplementation(() => {
            calls.push('push')
            return new Promise<void>((resolve) => {
                finishNavigation = resolve
            })
        })
        route.query = { redirect: '/support' }
        const { useCompleteSignIn } = await import('../useCompleteSignIn')
        useCompleteSignIn(() => calls.push('onSignedIn'))({ id: '1' })
        await Promise.resolve()

        expect(calls).toEqual(['setUser', 'onSignedIn', 'push'])
        finishNavigation?.()
        await Promise.resolve()
        await Promise.resolve()

        expect(calls).toEqual(['setUser', 'onSignedIn', 'push', 'init_app'])
    })

    it('still has the app read the session when the navigation fails', async () => {
        push.mockImplementation(() => {
            calls.push('push')
            return Promise.reject(new Error('navigation aborted'))
        })
        await signIn()

        expect(calls).toEqual(['setUser', 'onSignedIn', 'push', 'init_app'])
    })

    it('forgets a target remembered for an OAuth sign-in that was not finished', async () => {
        const { rememberPostSignInTarget, takePostSignInTarget } =
            await import('@/utils/post-sign-in-target')
        rememberPostSignInTarget('/admin/users')

        await signIn()

        expect(takePostSignInTarget()).toBeNull()
    })
})
