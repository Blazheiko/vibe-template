import type { ProfilePreferences } from 'shared'
import { useStateStore, type DevicePreference } from '@/stores/state'
import { useUserStore } from '@/stores/user'
import { useProfileSave, type SaveOutcome } from '@/composables/useProfileSave'

/** The font size slider sends only its final value (Р11). */
export const FONT_SIZE_SAVE_DELAY_MS = 600

/**
 * One way to change a preference, wherever the control is (the account page, the menu): a
 * signed-in user's choice goes to the profile save queue, an anonymous visitor's stays on the
 * device (feat-232, Р10).
 */
export function usePreferences() {
    const userStore = useUserStore()
    const stateStore = useStateStore()
    const queue = useProfileSave()

    function set<K extends keyof ProfilePreferences>(
        key: K,
        value: ProfilePreferences[K],
        options: { delayMs?: number } = {},
    ): Promise<SaveOutcome> {
        if (userStore.user !== null && queue.ownerId() === userStore.user.id) {
            return queue.change({ [key]: value }, options)
        }
        if (key === 'theme' || key === 'colorTheme' || key === 'fontSize') {
            stateStore.setDevicePreference(key, value as ProfilePreferences[DevicePreference])
        }
        return Promise.resolve({ status: 'dropped' })
    }

    return {
        setTheme: (value: ProfilePreferences['theme']) => set('theme', value),
        /** Flips between light and dark, starting from what is shown now. */
        toggleDarkMode: () => set('theme', stateStore.darkMode ? 'light' : 'dark'),
        setColorTheme: (value: ProfilePreferences['colorTheme']) => set('colorTheme', value),
        setFontSize: (value: ProfilePreferences['fontSize']) =>
            set('fontSize', value, { delayMs: value === null ? 0 : FONT_SIZE_SAVE_DELAY_MS }),
    }
}
