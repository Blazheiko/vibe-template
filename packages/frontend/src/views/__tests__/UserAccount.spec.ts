import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import UserAccount from '../UserAccount.vue'
import en from '../../locales/en'

const { currentUser, resendOAuthEmailLinkMock, signInMethodsMock, unlinkSignInMethodMock } =
    vi.hoisted(() => {
        const currentUser: { value: Record<string, unknown> } = {
            value: { id: '1', name: 'Jane', email: 'jane@example.com' },
        }
        return {
            currentUser,
            resendOAuthEmailLinkMock: vi.fn(),
            signInMethodsMock: vi.fn(),
            unlinkSignInMethodMock: vi.fn(),
        }
    })

vi.mock('@/utils/api', () => ({
    avatarApi: { upload: vi.fn(), delete: vi.fn() },
    authApi: {
        changePassword: vi.fn(),
        resendVerificationEmail: vi.fn(),
        startPhoneLink: vi.fn(),
        confirmPhoneLink: vi.fn(),
        startEmailLink: vi.fn(),
        resendOAuthEmailLink: resendOAuthEmailLinkMock,
        signInMethods: signInMethodsMock,
        unlinkSignInMethod: unlinkSignInMethodMock,
    },
    pushSubscriptionApi: { testPush: vi.fn() },
}))
vi.mock('@/stores/user', () => ({
    useUserStore: () => ({
        get user() {
            return currentUser.value
        },
        setUser: vi.fn(),
    }),
}))
vi.mock('@/stores/state', () => ({
    useStateStore: () => ({
        darkMode: false,
        fontSize: 16,
        setFontSize: vi.fn(),
        setColorTheme: vi.fn(),
        setDarkMode: vi.fn(),
    }),
}))
vi.mock('@/stores/push', () => ({
    usePushStore: () => ({
        isSubscribedToPush: false,
        ensurePushSubscriptionsLoaded: vi.fn().mockResolvedValue(undefined),
        ensureNotificationPermission: vi.fn(),
        subscribeToPush: vi.fn(),
        unsubscribeFromPush: vi.fn(),
    }),
}))
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketOpen: vi.fn() }),
}))
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit: vi.fn(), on: vi.fn() }) }))

const methodsAnswer = (methods: Record<string, unknown>[], hasPassword = true) => ({
    data: { status: 'success', hasPassword, methods },
    error: null,
})

beforeEach(() => {
    signInMethodsMock.mockReset()
    unlinkSignInMethodMock.mockReset()
    // No linked sign-in method unless a test says otherwise.
    signInMethodsMock.mockResolvedValue(methodsAnswer([]))
})

const mountAccount = () =>
    mount(UserAccount, {
        global: {
            plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
            stubs: { AvatarEditorModal: true },
        },
    })

// F4 (feat-068): a password manager and the browser decide what to fill, and whether to offer
// to save, from `autocomplete` and `name`. Without them the current password can be offered as
// the new one, or the new one overwrite the saved one.
describe('UserAccount password fields', () => {
    const passwordInputs = () => mountAccount().findAll('input[type="password"]')

    it('has the password inputs of the change-password form and the two re-authentication fields', () => {
        expect(passwordInputs()).toHaveLength(5)
    })

    it('tells the browser which password is the current one and which are new', () => {
        // In the order of the form: current, new, confirm; then the two re-authentication fields
        // (linking a phone, linking an email), which ask for the account's current password.
        expect(passwordInputs().map((input) => input.attributes('autocomplete'))).toEqual([
            'current-password',
            'new-password',
            'new-password',
            'current-password',
            'current-password',
        ])
    })

    it('gives every password input a name', () => {
        for (const input of passwordInputs()) {
            expect(input.attributes('name')).toBeTruthy()
        }
        const names = passwordInputs().map((input) => input.attributes('name'))
        expect(new Set(names).size).toBe(names.length)
    })

    it('labels the contact fields for the browser as well', () => {
        const wrapper = mountAccount()

        expect(wrapper.find('input[type="email"]').attributes('autocomplete')).toBe('email')
        expect(wrapper.find('input[type="email"]').attributes('name')).toBeTruthy()
        expect(wrapper.find('input[autocomplete="tel"]').exists()).toBe(true)
    })
})

// feat-097: an account created through GitHub, GitLab or Facebook has no email until its owner
// confirms the provider's address.
describe('UserAccount email awaiting confirmation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        currentUser.value = { id: '2', name: 'Octo', email: null, phone: null }
    })

    const pending = (wrapper: ReturnType<typeof mountAccount>) => wrapper.find('.pending-email')

    it('is shown for an account with neither an email nor a phone', () => {
        expect(pending(mountAccount()).text()).toContain(en.account.emailVerification.pending)
    })

    it('is not shown for an account with an email or a phone-only account', () => {
        currentUser.value = { id: '1', name: 'Jane', email: 'jane@example.com' }
        expect(pending(mountAccount()).exists()).toBe(false)
        currentUser.value = { id: '3', name: 'Phone', email: null, phone: '+15550000000' }
        expect(pending(mountAccount()).exists()).toBe(false)
    })

    it('sends the link again', async () => {
        resendOAuthEmailLinkMock.mockResolvedValueOnce({
            data: { status: 'success', message: 'sent' },
            error: null,
        })
        const wrapper = mountAccount()
        await pending(wrapper).find('button').trigger('click')
        await flushPromises()

        expect(resendOAuthEmailLinkMock).toHaveBeenCalledOnce()
        expect(wrapper.text()).toContain(en.account.emailVerification.pendingSent)
    })

    it.each([
        [400, 'no_pending_email', en.account.emailVerification.noPendingEmail],
        [409, undefined, en.account.emailVerification.pendingConflict],
    ])('explains a %i refusal', async (status, reason, text) => {
        resendOAuthEmailLinkMock.mockResolvedValueOnce({
            data: {
                status: 'error',
                code: status === 409 ? 'conflict' : 'bad_request',
                message: 'refused',
                ...(reason === undefined ? {} : { reason }),
            },
            error: { message: 'refused', transportCode: status },
        })
        const wrapper = mountAccount()
        await pending(wrapper).find('button').trigger('click')
        await flushPromises()

        expect(wrapper.text()).toContain(text)
    })
})

// feat-199 (security review 2026-11-12, M-2): the OAuth identities linked to the account can be
// seen and removed.
describe('UserAccount sign-in methods', () => {
    const GITHUB = { id: '31', provider: 'github', name: 'Jane', linkedAt: '2026-11-01T10:00:00Z' }
    const GOOGLE = { id: '32', provider: 'google', name: null, linkedAt: '2026-11-05T10:00:00Z' }

    const panel = async (methods: Record<string, unknown>[], hasPassword = true) => {
        signInMethodsMock.mockResolvedValue(methodsAnswer(methods, hasPassword))
        const wrapper = mountAccount()
        await flushPromises()
        return wrapper.get('[data-testid="sign-in-methods"]')
    }

    it('says so when no other service is linked, and asks for no password', async () => {
        const section = await panel([])

        expect(section.text()).toContain('No other service is linked.')
        expect(section.findAll('li')).toHaveLength(0)
        expect(section.find('input[type="password"]').exists()).toBe(false)
    })

    it('lists the linked services by name, with the profile name when there is one', async () => {
        const section = await panel([GITHUB, GOOGLE])

        const items = section.findAll('li')
        expect(items).toHaveLength(2)
        expect(items[0]?.text()).toContain('GitHub')
        expect(items[0]?.text()).toContain('Jane')
        expect(items[1]?.text()).toContain('Google')
        expect(items[1]?.attributes('data-provider')).toBe('google')
    })

    it('removes a method with the current password and reads the list again', async () => {
        const section = await panel([GITHUB, GOOGLE])
        unlinkSignInMethodMock.mockResolvedValue({ data: { status: 'success' }, error: null })
        signInMethodsMock.mockResolvedValue(methodsAnswer([GOOGLE]))

        const password = section.get('input[name="unlink-current-password"]')
        expect(password.attributes('autocomplete')).toBe('current-password')
        await password.setValue('my-password-1')
        await section.findAll('li button')[0]?.trigger('click')
        await flushPromises()

        expect(unlinkSignInMethodMock).toHaveBeenCalledWith({
            id: '31',
            currentPassword: 'my-password-1',
        })
        expect(section.findAll('li')).toHaveLength(1)
        expect(section.text()).toContain('GitHub was removed')
    })

    it('does not call the server without the current password', async () => {
        const section = await panel([GITHUB])

        await section.get('li button').trigger('click')
        await flushPromises()

        expect(unlinkSignInMethodMock).not.toHaveBeenCalled()
        expect(section.text()).toContain('Enter your current password to remove a sign-in method')
    })

    it('an account without a password sends none and is told the rules', async () => {
        const section = await panel([GITHUB, GOOGLE], false)
        unlinkSignInMethodMock.mockResolvedValue({ data: { status: 'success' }, error: null })

        expect(section.find('input[type="password"]').exists()).toBe(false)
        expect(section.text()).toContain('This account has no password')
        await section.findAll('li button')[1]?.trigger('click')
        await flushPromises()

        expect(unlinkSignInMethodMock).toHaveBeenCalledWith({ id: '32' })
    })

    it.each([
        ['current_password_incorrect', 'Current password is incorrect'],
        ['recent_sign_in_required', 'Sign out and sign in again, then remove the sign-in method'],
        ['last_sign_in_method', 'Set a password before removing your last sign-in method'],
    ])('explains a refusal with reason %s and keeps the list', async (reason, text) => {
        const section = await panel([GITHUB], false)
        unlinkSignInMethodMock.mockResolvedValue({
            data: { status: 'error', code: 'conflict', message: 'server words', reason },
            error: { message: 'server words' },
        })

        await section.get('li button').trigger('click')
        await flushPromises()

        expect(section.text()).toContain(text)
        expect(section.findAll('li')).toHaveLength(1)
        expect(signInMethodsMock).toHaveBeenCalledTimes(1)
    })

    it('shows that the list could not be loaded', async () => {
        signInMethodsMock.mockResolvedValue({ data: null, error: { message: 'Network error' } })
        const wrapper = mountAccount()
        await flushPromises()

        const section = wrapper.get('[data-testid="sign-in-methods"]')
        expect(section.text()).toContain('Network error')
        expect(section.text()).not.toContain('No other service is linked.')
    })
})
