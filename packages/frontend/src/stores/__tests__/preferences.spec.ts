import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from 'shared'

vi.mock('@/utils/sentry-service', () => ({ sentryService: { setUser: vi.fn() } }))

import { ACCOUNT_POINTER_KEY, accountCacheKey, useStateStore } from '../state'
import { isNewerOrSameRevision, useUserStore } from '../user'

// feat-232 T9-T10 (Р2, Р6, Р10, Р12, Р13): the preferences the page shows, their cache and the
// revision of the profile.

const listeners: ((event: { matches: boolean }) => void)[] = []
let systemIsDark = false

function stubMatchMedia() {
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: query === '(prefers-color-scheme: dark)' ? systemIsDark : false,
            addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
                listeners.push(listener)
            },
            removeEventListener: vi.fn(),
        })),
    )
}

const prefs = (fields: Partial<Profile['preferences']> = {}): Profile['preferences'] => ({
    locale: null,
    timeZone: null,
    theme: null,
    colorTheme: null,
    fontSize: null,
    ...fields,
})

const freshStore = () => {
    setActivePinia(createPinia())
    return useStateStore()
}

beforeEach(() => {
    localStorage.clear()
    listeners.length = 0
    systemIsDark = false
    stubMatchMedia()
})
afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.className = ''
})

describe('shown preferences', () => {
    it('null shows the defaults: the system theme, the default color and font size', () => {
        systemIsDark = true
        const state = freshStore()

        state.showAccountPreferences('7', prefs())

        expect(state.darkMode).toBe(true)
        expect(state.colorTheme).toBe('rose')
        expect(state.fontSize).toBe(16)
        expect(document.documentElement.getAttribute('data-theme')).toBe('rose')
    })

    it('a null from the server replaces what the cache held', () => {
        localStorage.setItem(ACCOUNT_POINTER_KEY, '7')
        localStorage.setItem(
            accountCacheKey('7'),
            JSON.stringify(prefs({ theme: 'dark', colorTheme: 'mint', fontSize: 19 })),
        )
        const state = freshStore()
        expect(state.colorTheme).toBe('mint')

        state.showAccountPreferences('7', prefs({ theme: 'light' }))

        expect(state.theme).toBe('light')
        expect(state.colorTheme).toBe('rose')
        expect(state.fontSize).toBe(16)
        expect(JSON.parse(localStorage.getItem(accountCacheKey('7')) ?? '{}')).toMatchObject({
            colorTheme: null,
            fontSize: null,
        })
    })

    it('the first frame takes prefs:<userId> of the account signed in last', () => {
        localStorage.setItem(ACCOUNT_POINTER_KEY, '7')
        localStorage.setItem(accountCacheKey('7'), JSON.stringify(prefs({ colorTheme: 'ocean' })))
        localStorage.setItem('colorTheme', 'sunset')

        const state = freshStore()

        expect(state.owner).toBe('7')
        expect(state.colorTheme).toBe('ocean')
        expect(document.documentElement.getAttribute('data-theme')).toBe('ocean')
    })

    it('a broken cache is ignored: the device preferences show', () => {
        localStorage.setItem(ACCOUNT_POINTER_KEY, '7')
        localStorage.setItem(accountCacheKey('7'), '{not json')
        localStorage.setItem('colorTheme', 'sunset')

        expect(freshStore().colorTheme).toBe('sunset')
    })

    it('signing out shows the device preferences; the next start does not show the account', () => {
        localStorage.setItem('colorTheme', 'sunset')
        const state = freshStore()
        state.showAccountPreferences('7', prefs({ colorTheme: 'mint', theme: 'dark' }))

        state.showDevicePreferences()

        expect(state.colorTheme).toBe('sunset')
        expect(state.theme).toBeNull()
        expect(localStorage.getItem(ACCOUNT_POINTER_KEY)).toBeNull()
        expect(freshStore().colorTheme).toBe('sunset')
    })

    it('signing in as another user does not carry the previous one over', () => {
        const state = freshStore()
        state.showAccountPreferences(
            '7',
            prefs({ colorTheme: 'mint', theme: 'dark', fontSize: 20 }),
        )

        // User 8 has no cache on this device yet: the device's own until their init arrives.
        state.showAccountFromCache('8')

        expect(state.owner).toBe('8')
        expect(state.colorTheme).toBe('rose')
        expect(state.theme).toBeNull()
        expect(state.fontSize).toBe(16)
    })

    it('signing in as another user shows their cache, not the previous user', () => {
        localStorage.setItem(accountCacheKey('8'), JSON.stringify(prefs({ colorTheme: 'ocean' })))
        const state = freshStore()
        state.showAccountPreferences('7', prefs({ colorTheme: 'mint', fontSize: 20 }))

        state.showAccountFromCache('8')

        expect(state.colorTheme).toBe('ocean')
        expect(state.fontSize).toBe(16)
    })

    it('a device choice writes the device keys, and only while nobody is signed in', () => {
        const state = freshStore()
        state.setDevicePreference('colorTheme', 'mint')
        expect(localStorage.getItem('colorTheme')).toBe('mint')

        state.showAccountPreferences('7', prefs())
        state.setDevicePreference('colorTheme', 'ocean')

        expect(localStorage.getItem('colorTheme')).toBe('mint')
        expect(state.colorTheme).toBe('rose')
    })
})

describe('system theme (Р13)', () => {
    it('follows the system only while no theme is chosen', () => {
        const state = freshStore()
        state.showAccountPreferences('7', prefs({ theme: 'light' }))

        state.setSystemDark(true)
        expect(state.darkMode).toBe(false)
        expect(document.documentElement.classList.contains('dark-theme')).toBe(false)

        state.showAccountPreferences('7', prefs({ theme: null }))
        expect(state.darkMode).toBe(true)

        state.setSystemDark(false)
        expect(state.darkMode).toBe(false)
    })

    it('an explicit dark stays dark when the system turns light', () => {
        systemIsDark = true
        const state = freshStore()
        state.showAccountPreferences('7', prefs({ theme: 'dark' }))

        state.setSystemDark(false)

        expect(state.darkMode).toBe(true)
    })
})

describe('profile revision (Р12)', () => {
    it('compares revisions as numbers', () => {
        expect(isNewerOrSameRevision('10', '9')).toBe(true)
        expect(isNewerOrSameRevision('9', '10')).toBe(false)
        expect(isNewerOrSameRevision('3', '3')).toBe(true)
        expect(isNewerOrSameRevision('9007199254740993', '9007199254740992')).toBe(true)
        expect(isNewerOrSameRevision('1', undefined)).toBe(true)
    })

    it('drops a snapshot with a lower revision; init applies preferences and name', () => {
        setActivePinia(createPinia())
        const users = useUserStore()
        users.setInitUser({
            id: '7',
            name: 'Ann',
            email: 'ann@example.com',
            emailVerified: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            preferences: prefs({ theme: 'dark' }),
            revision: '10',
        })
        expect(users.profile?.revision).toBe('10')
        expect(users.user).not.toHaveProperty('preferences')

        expect(users.applyProfile({ name: 'Old', preferences: prefs(), revision: '9' })).toBe(false)
        expect(users.profile?.preferences.theme).toBe('dark')
        expect(users.user?.name).toBe('Ann')

        expect(users.applyProfile({ name: 'New', preferences: prefs(), revision: '11' })).toBe(true)
        expect(users.user?.name).toBe('New')
    })

    it('another user drops the profile of the previous one', () => {
        setActivePinia(createPinia())
        const users = useUserStore()
        users.setUser({ id: '7' })
        users.applyProfile({ name: 'Ann', preferences: prefs({ theme: 'dark' }), revision: '50' })

        users.setUser({ id: '8' })

        expect(users.profile).toBeNull()
        // Revision 1 of the new user is not "older" than 50 of the previous one.
        expect(users.applyProfile({ name: 'Bob', preferences: prefs(), revision: '1' })).toBe(true)
    })
})
