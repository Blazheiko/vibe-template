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

// feat-232: the profile and its save queue. The queue itself is tested in useProfileSave.spec.ts;
// here it only records what the page asks it to send.
const JANE = {
    name: 'Jane',
    preferences: {
        locale: null as string | null,
        timeZone: null as string | null,
        theme: 'dark' as string | null,
        colorTheme: null as string | null,
        fontSize: null as number | null,
    },
    revision: '3',
}
// Reactive, as the store is: a profile from a WS event or another answer reaches the page.
const profileState = await vi.hoisted(async () => {
    const { ref } = await import('vue')
    return {
        profile: ref<Record<string, unknown> | null>(null),
        change: vi.fn(),
    }
})
vi.mock('@/composables/useProfileSave', async () => {
    const { computed, ref } = await import('vue')
    return {
        useProfileSave: () => ({
            change: profileState.change,
            ownerId: () => '1',
            shown: computed(() => profileState.profile.value),
            lastFailure: ref(null),
            saving: ref(false),
        }),
    }
})

// feat-233: the session list has its own spec (ActiveSessions.spec.ts).
vi.mock('@/components/account/ActiveSessions.vue', () => ({
    default: { name: 'ActiveSessions', template: '<section id="sessions" />' },
}))

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
    // feat-236: the notification preferences on the page (own spec).
    notificationsApi: {
        getPreferences: vi.fn(() =>
            Promise.resolve({ data: { status: 'success', preferences: [] }, error: null }),
        ),
        updatePreference: vi.fn(),
    },
}))
vi.mock('@/stores/user', () => ({
    useUserStore: () => ({
        get user() {
            return currentUser.value
        },
        get profile() {
            return profileState.profile.value
        },
        setUser: vi.fn(),
    }),
}))
vi.mock('@/stores/state', () => ({
    useStateStore: () => ({
        darkMode: true,
        theme: 'dark',
        fontSize: 16,
        timeZone: null,
        setDevicePreference: vi.fn(),
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
const ws = vi.hoisted(() => ({
    calls: [] as string[],
    websocketOpen: vi.fn(),
    suspendReconnect: vi.fn(),
    resumeReconnect: vi.fn(),
    emit: vi.fn(),
}))
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({
        websocketOpen: ws.websocketOpen,
        suspendReconnect: ws.suspendReconnect,
        resumeReconnect: ws.resumeReconnect,
    }),
}))
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit: ws.emit, on: vi.fn() }) }))

const methodsAnswer = (methods: Record<string, unknown>[], hasPassword = true) => ({
    data: { status: 'success', hasPassword, methods },
    error: null,
})

beforeEach(() => {
    profileState.profile.value = structuredClone(JANE)
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

// feat-221: the server closes the old session's sockets (4001) before the answer of the password
// change brings the renewed session. A token refresh started by that close would carry the old
// cookie, get 401 and sign the user out; the view holds it back for the whole request.
describe('UserAccount password change and the WebSocket', () => {
    const NEW_PASSWORD = 'new-secret-456'

    const submitPasswordChange = async () => {
        const wrapper = mountAccount()
        const inputs = wrapper.findAll('input[type="password"]')
        await inputs[0]?.setValue('old-secret-123')
        await inputs[1]?.setValue(NEW_PASSWORD)
        await inputs[2]?.setValue(NEW_PASSWORD)
        // The first primary button of the security panel (the profile form has its own).
        const button = wrapper
            .findAll('button')
            .find(
                (candidate) =>
                    candidate.attributes('class')?.includes('primary-button') &&
                    candidate.attributes('type') !== 'submit',
            )
        await button?.trigger('click')
        await flushPromises()
    }

    beforeEach(async () => {
        ws.calls.length = 0
        for (const name of ['websocketOpen', 'suspendReconnect', 'resumeReconnect'] as const) {
            ws[name].mockReset()
            ws[name].mockImplementation(() => {
                ws.calls.push(name)
            })
        }
        ws.emit.mockReset()
        const { authApi } = await import('@/utils/api')
        vi.mocked(authApi.changePassword).mockReset()
    })

    const answer = async (result: unknown) => {
        const { authApi } = await import('@/utils/api')
        vi.mocked(authApi.changePassword).mockImplementation(() => {
            ws.calls.push('request')
            return Promise.resolve(result as never)
        })
    }

    it('holds the reconnect back for the request and opens the socket of the renewed session', async () => {
        await answer({
            data: {
                status: 'success',
                sessionRenewed: true,
                csrfToken: 'c'.repeat(43),
                wsUrl: 'wss://x/ws',
                wsToken: 'renewed-ws-token',
            },
            error: null,
        })

        await submitPasswordChange()

        expect(ws.calls).toEqual([
            'suspendReconnect',
            'request',
            'websocketOpen',
            'resumeReconnect',
        ])
        expect(ws.websocketOpen).toHaveBeenCalledWith('wss://x/ws', 'renewed-ws-token')
    })

    it('resumes the reconnect when the session was not renewed', async () => {
        await answer({ data: { status: 'success', sessionRenewed: false }, error: null })

        await submitPasswordChange()

        expect(ws.calls).toEqual(['suspendReconnect', 'request', 'resumeReconnect'])
        expect(ws.emit).toHaveBeenCalledWith('init_app')
    })

    it('resumes the reconnect when the password change fails', async () => {
        await answer({
            data: {
                status: 'error',
                code: 'bad_request',
                message: 'Current password is incorrect',
            },
            error: {
                code: 'bad_request',
                transportCode: 400,
                message: 'Current password is incorrect',
            },
        })

        await submitPasswordChange()

        expect(ws.calls).toEqual(['suspendReconnect', 'request', 'resumeReconnect'])
        expect(ws.websocketOpen).not.toHaveBeenCalled()
    })
})

// feat-232 T13: the profile form sends only what changed; the settings save through the queue.
describe('UserAccount profile form and settings', () => {
    beforeEach(() => {
        profileState.profile.value = structuredClone(JANE)
        currentUser.value = { id: '1', name: 'Jane', email: 'jane@example.com' }
        profileState.change.mockReset()
        profileState.change.mockResolvedValue({
            status: 'saved',
            profile: profileState.profile.value,
        })
    })

    it('shows the saved name, the browser language and the browser zone', () => {
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        expect((form.find('input[name="profile-name"]').element as HTMLInputElement).value).toBe(
            'Jane',
        )
        expect(
            (form.find('select[name="profile-locale"]').element as HTMLSelectElement).value,
        ).toBe('')
        expect(
            (form.find('select[name="profile-time-zone"]').element as HTMLSelectElement).value,
        ).toBe('')
    })

    it('sends only the changed fields', async () => {
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        await form.find('select[name="profile-locale"]').setValue('uk')
        await form.find('form').trigger('submit')
        await flushPromises()

        expect(profileState.change).toHaveBeenCalledExactlyOnceWith({ locale: 'uk' })
    })

    it('sends a trimmed new name and a chosen zone, and UTC is on the list', async () => {
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')
        const zones = form.findAll('select[name="profile-time-zone"] option')
        expect(zones.map((option) => option.attributes('value'))).toContain('UTC')

        await form.find('input[name="profile-name"]').setValue('  Ann  ')
        await form.find('select[name="profile-time-zone"]').setValue('UTC')
        await form.find('form').trigger('submit')
        await flushPromises()

        expect(profileState.change).toHaveBeenCalledWith({ name: 'Ann', timeZone: 'UTC' })
    })

    it('narrows the zones to the search', async () => {
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        await form.find('input[name="profile-time-zone-search"]').setValue('new york')

        const values = form
            .findAll('select[name="profile-time-zone"] option')
            .map((option) => option.attributes('value'))
        expect(values).toEqual(['', 'America/New_York'])
    })

    it('an empty name is refused before any request', async () => {
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        await form.find('input[name="profile-name"]').setValue('   ')
        await form.find('form').trigger('submit')
        await flushPromises()

        expect(profileState.change).not.toHaveBeenCalled()
        expect(form.find('[data-testid="profile-name-error"]').text()).toBe('Enter a name')
    })

    it('shows the server validation error next to the name field', async () => {
        profileState.change.mockResolvedValue({
            status: 'failed',
            kind: 'validation',
            message: 'Validation failed',
            messages: ['name must be free of control characters and line breaks'],
            reason: undefined,
        })
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        await form.find('input[name="profile-name"]').setValue('Bad name')
        await form.find('form').trigger('submit')
        await flushPromises()

        expect(form.find('[data-testid="profile-name-error"]').text()).toBe(
            'name must be free of control characters and line breaks',
        )
    })

    it('a rate limit has its own message', async () => {
        profileState.change.mockResolvedValue({
            status: 'failed',
            kind: 'rate_limited',
            message: 'Too many profile changes.',
            messages: [],
            reason: undefined,
        })
        const wrapper = mountAccount()
        const form = wrapper.find('[data-testid="profile-form"]')

        await form.find('select[name="profile-locale"]').setValue('pl')
        await form.find('form').trigger('submit')
        await flushPromises()

        expect(form.text()).toContain('Too many changes. Try again in a few minutes.')
    })

    it('"Same as the system" sends theme: null; a color and its default go through the queue', async () => {
        const wrapper = mountAccount()
        const panel = wrapper.find('[data-testid="preferences"]')

        await panel.find('input[name="theme"][value="system"]').setValue(true)
        await panel.find('[data-color-theme="mint"]').trigger('click')
        await panel.find('[data-testid="color-theme-default"]').trigger('click')

        expect(profileState.change.mock.calls.map((call) => call[0])).toEqual([
            { theme: null },
            { colorTheme: 'mint' },
            { colorTheme: null },
        ])
    })

    it('the font size slider waits for the final value', async () => {
        const wrapper = mountAccount()
        const panel = wrapper.find('[data-testid="preferences"]')

        await panel.find('input[name="font-size"]').setValue('18')

        expect(profileState.change).toHaveBeenCalledWith(
            { fontSize: 18 },
            { delayMs: expect.any(Number) as number },
        )
        const delay = (profileState.change.mock.calls[0][1] as { delayMs: number }).delayMs
        expect(delay).toBeGreaterThanOrEqual(500)
        expect(delay).toBeLessThanOrEqual(800)
    })
})

// Review 2026-11-19, items 2 and 3.
describe('UserAccount profile form: each field on its own', () => {
    const form = (wrapper: ReturnType<typeof mountAccount>) =>
        wrapper.find('[data-testid="profile-form"]')
    const nameInput = (wrapper: ReturnType<typeof mountAccount>) =>
        form(wrapper).find('input[name="profile-name"]')

    beforeEach(() => {
        currentUser.value = { id: '1', name: 'Jane', email: 'jane@example.com' }
        profileState.profile.value = structuredClone(JANE)
        profileState.change.mockReset()
    })

    it('a language changed in another tab is shown and not sent back with the name', async () => {
        profileState.change.mockResolvedValue({ status: 'saved', profile: JANE })
        const wrapper = mountAccount()
        await nameInput(wrapper).setValue('New name')

        // Another tab set the language; the event reached this page.
        profileState.profile.value = {
            ...JANE,
            preferences: { ...JANE.preferences, locale: 'uk' },
            revision: '4',
        }
        await flushPromises()
        expect(
            (form(wrapper).find('select[name="profile-locale"]').element as HTMLSelectElement)
                .value,
        ).toBe('uk')

        await form(wrapper).find('form').trigger('submit')
        await flushPromises()

        expect(profileState.change).toHaveBeenCalledExactlyOnceWith({ name: 'New name' })
    })

    it('text typed while the save is under way is kept after its answer', async () => {
        let answer: (value: unknown) => void = () => undefined
        profileState.change.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve
                }),
        )
        const wrapper = mountAccount()
        await nameInput(wrapper).setValue('First')
        await form(wrapper).find('form').trigger('submit')
        await nameInput(wrapper).setValue('Second')

        const saved = { ...JANE, name: 'First', revision: '4' }
        profileState.profile.value = saved
        answer({ status: 'saved', profile: saved })
        await flushPromises()

        expect((nameInput(wrapper).element as HTMLInputElement).value).toBe('Second')

        profileState.change.mockResolvedValue({ status: 'saved', profile: saved })
        await form(wrapper).find('form').trigger('submit')
        await flushPromises()
        expect(profileState.change).toHaveBeenLastCalledWith({ name: 'Second' })
    })

    it('a field saved as it was sent follows the profile again', async () => {
        profileState.change.mockImplementation(() => {
            profileState.profile.value = { ...JANE, name: 'Ann', revision: '4' }
            return Promise.resolve({ status: 'saved', profile: profileState.profile.value })
        })
        const wrapper = mountAccount()
        await nameInput(wrapper).setValue('Ann')
        await form(wrapper).find('form').trigger('submit')
        await flushPromises()

        profileState.profile.value = { ...JANE, name: 'Renamed elsewhere', revision: '5' }
        await flushPromises()

        expect((nameInput(wrapper).element as HTMLInputElement).value).toBe('Renamed elsewhere')
    })
})
