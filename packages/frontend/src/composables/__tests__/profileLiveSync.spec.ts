import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Profile } from 'shared'

vi.mock('@/utils/api', () => ({ accountApi: { getProfile: vi.fn(), updateProfile: vi.fn() } }))

import { createProfileLiveSync } from '../useProfileSave'

// feat-232 (Р9 B): the profile event of the server and the re-read after a reconnect.

const profile = (revision: string, theme: 'light' | 'dark' | null = null): Profile => ({
    name: 'Ann',
    preferences: { locale: null, timeZone: null, theme, colorTheme: null, fontSize: null },
    revision,
})

function setup() {
    const userId = ref<string | null>('7')
    const shown = ref<Profile>(profile('5', 'light'))
    const applyProfile = vi.fn((next: Profile) => {
        if (BigInt(next.revision) >= BigInt(shown.value.revision)) shown.value = next
    })
    const fetchProfile = vi.fn(() => Promise.resolve<Profile | null>(profile('8', 'dark')))
    const live = createProfileLiveSync({
        applyProfile,
        currentUserId: () => userId.value,
        fetchProfile,
    })
    return { live, userId, shown, applyProfile, fetchProfile }
}

describe('profile live sync', () => {
    it('applies the event of a newer revision and drops an older one', () => {
        const { live, shown } = setup()

        live.onProfileEvent(profile('6', 'dark'))
        expect(shown.value.preferences.theme).toBe('dark')

        live.onProfileEvent(profile('4', 'light'))
        expect(shown.value.revision).toBe('6')
        expect(shown.value.preferences.theme).toBe('dark')
    })

    it('an event while nobody is signed in is ignored', () => {
        const { live, userId, applyProfile } = setup()
        userId.value = null

        live.onProfileEvent(profile('9', 'dark'))

        expect(applyProfile).not.toHaveBeenCalled()
    })

    it('reads the profile again after a reconnect, not after the first connection', async () => {
        const { live, shown, fetchProfile } = setup()

        await live.onConnected()
        expect(fetchProfile).not.toHaveBeenCalled()

        await live.onConnected()
        expect(fetchProfile).toHaveBeenCalledOnce()
        expect(shown.value.revision).toBe('8')
    })

    it('the first connection of another account is not a reconnect', async () => {
        const { live, userId, fetchProfile } = setup()
        await live.onConnected()

        userId.value = '9'
        await live.onConnected()

        expect(fetchProfile).not.toHaveBeenCalled()
    })

    it('an answer that arrives after the account changed is dropped', async () => {
        const { live, userId, applyProfile, fetchProfile } = setup()
        await live.onConnected()
        let answer: (value: Profile | null) => void = () => undefined
        fetchProfile.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve
                }),
        )

        const reread = live.onConnected()
        userId.value = '9'
        answer(profile('20', 'dark'))
        await reread

        expect(applyProfile).not.toHaveBeenCalled()
    })
})
