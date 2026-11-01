import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'

import UserAccount from '../UserAccount.vue'
import en from '../../locales/en'

vi.mock('@/utils/api', () => ({
    avatarApi: { upload: vi.fn(), delete: vi.fn() },
    authApi: {
        changePassword: vi.fn(),
        resendVerificationEmail: vi.fn(),
        startPhoneLink: vi.fn(),
        confirmPhoneLink: vi.fn(),
        startEmailLink: vi.fn(),
    },
    pushSubscriptionApi: { testPush: vi.fn() },
}))
vi.mock('@/stores/user', () => ({
    useUserStore: () => ({
        user: { id: '1', name: 'Jane', email: 'jane@example.com' },
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
