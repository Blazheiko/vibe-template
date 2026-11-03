import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import UserAccount from '../UserAccount.vue'
import en from '../../locales/en'

const { currentUser, resendOAuthEmailLinkMock } = vi.hoisted(() => {
    const currentUser: { value: Record<string, unknown> } = {
        value: { id: '1', name: 'Jane', email: 'jane@example.com' },
    }
    return { currentUser, resendOAuthEmailLinkMock: vi.fn() }
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
