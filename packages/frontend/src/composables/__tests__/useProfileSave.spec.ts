import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Profile } from 'shared'

vi.mock('@/utils/api', () => ({ accountApi: { updateProfile: vi.fn() } }))

import { createProfileSaveQueue, type ProfileChanges, type SendResult } from '../useProfileSave'

// feat-232 T11 (Р10, Р11): the save queue with the API replaced by requests the test answers
// in the order it wants.

const profile = (fields: Partial<Profile['preferences']> = {}, revision = '1'): Profile => ({
    name: 'Ann',
    preferences: {
        locale: null,
        timeZone: null,
        theme: null,
        colorTheme: null,
        fontSize: null,
        ...fields,
    },
    revision,
})

interface Call {
    body: ProfileChanges
    resolve: (result: SendResult) => void
}

function setup(initialUser = '7') {
    const calls: Call[] = []
    const userId = ref<string | null>(initialUser)
    const confirmed = ref<Profile | null>(profile())
    const send = vi.fn(
        (body: ProfileChanges) =>
            new Promise<SendResult>((resolve) => {
                calls.push({ body, resolve })
            }),
    )
    const applyProfile = vi.fn((next: Profile) => {
        // As the user store does: an older revision is dropped.
        if (confirmed.value === null || BigInt(next.revision) >= BigInt(confirmed.value.revision)) {
            confirmed.value = next
        }
    })
    const queue = createProfileSaveQueue({
        send,
        applyProfile,
        currentUserId: () => userId.value,
        confirmed: () => confirmed.value,
    })
    const shownTheme = () => queue.shown.value?.preferences.theme
    return { queue, calls, send, applyProfile, userId, confirmed, shownTheme }
}

// setTimeout is faked: let the pending promise callbacks run.
const tick = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
    vi.useRealTimers()
})

describe('profile save queue', () => {
    it('sends one PATCH at a time; changes made meanwhile merge into the next, changed fields only', async () => {
        const { queue, calls } = setup()

        void queue.change({ theme: 'dark' })
        void queue.change({ colorTheme: 'mint' })
        void queue.change({ colorTheme: 'ocean' })
        void queue.change({ fontSize: 18 })

        expect(calls.map((call) => call.body)).toEqual([{ theme: 'dark' }])
        calls[0].resolve({ ok: true, profile: profile({ theme: 'dark' }, '2') })
        await vi.waitFor(() => {
            expect(calls).toHaveLength(2)
        })
        expect(calls[1].body).toEqual({ colorTheme: 'ocean', fontSize: 18 })
    })

    it('shows the confirmed profile with the pending changes on top', () => {
        const { queue, shownTheme } = setup()

        void queue.change({ theme: 'dark' })

        expect(shownTheme()).toBe('dark')
        expect(queue.shown.value?.revision).toBe('1')
    })

    it('a success with the old value keeps the newer choice and sends it next', async () => {
        const { queue, calls, shownTheme, confirmed } = setup()

        void queue.change({ theme: 'dark' })
        void queue.change({ theme: 'light' })
        expect(shownTheme()).toBe('light')

        calls[0].resolve({ ok: true, profile: profile({ theme: 'dark' }, '2') })
        await vi.waitFor(() => {
            expect(calls).toHaveLength(2)
        })

        expect(confirmed.value?.preferences.theme).toBe('dark')
        expect(shownTheme()).toBe('light')
        expect(calls[1].body).toEqual({ theme: 'light' })
    })

    it('a failure of the older request does not roll the newer value back', async () => {
        const { queue, calls, shownTheme } = setup()

        void queue.change({ theme: 'dark' })
        void queue.change({ theme: 'light' })
        calls[0].resolve({ ok: false, kind: 'error', message: 'down' })
        await vi.waitFor(() => {
            expect(calls).toHaveLength(2)
        })

        expect(shownTheme()).toBe('light')
        expect(calls[1].body).toEqual({ theme: 'light' })
    })

    it('a failure clears the fields it sent and the page shows the confirmed state again', async () => {
        const { queue, calls, shownTheme } = setup()

        const outcome = queue.change({ theme: 'dark' })
        calls[0].resolve({ ok: false, kind: 'rate_limited', message: 'Too many' })

        await expect(outcome).resolves.toMatchObject({ status: 'failed', kind: 'rate_limited' })
        expect(shownTheme()).toBeNull()
        expect(queue.lastFailure.value).toMatchObject({ kind: 'rate_limited' })
        expect(calls).toHaveLength(1)
    })

    it('answers arriving out of order: an older snapshot never replaces a newer one', async () => {
        const { queue, calls, confirmed } = setup()

        void queue.change({ theme: 'dark' })
        // Another tab saved meanwhile and init brought revision 5.
        confirmed.value = profile({ theme: 'light', colorTheme: 'mint' }, '5')
        calls[0].resolve({ ok: true, profile: profile({ theme: 'dark' }, '4') })
        await tick()

        expect(confirmed.value.revision).toBe('5')
        expect(queue.shown.value?.preferences.colorTheme).toBe('mint')
    })

    it('the font size waits for the last value of the slider', async () => {
        const { queue, calls } = setup()

        for (const size of [15, 16, 17, 18]) void queue.change({ fontSize: size }, { delayMs: 600 })
        expect(calls).toHaveLength(0)

        await vi.advanceTimersByTimeAsync(599)
        expect(calls).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1)

        expect(calls.map((call) => call.body)).toEqual([{ fontSize: 18 }])
    })

    it('a sign-out during the delay: the timer stops, nothing is sent', async () => {
        const { queue, calls, userId, shownTheme } = setup()

        const outcome = queue.change({ fontSize: 19 }, { delayMs: 600 })
        userId.value = null
        queue.reset(null)
        await vi.advanceTimersByTimeAsync(1000)

        expect(calls).toHaveLength(0)
        await expect(outcome).resolves.toEqual({ status: 'dropped' })
        expect(shownTheme()).toBeNull()
    })

    it('another account during a request: its answer is ignored and no PATCH carries the old changes', async () => {
        const { queue, calls, userId, applyProfile } = setup('7')

        const first = queue.change({ theme: 'dark' })
        void queue.change({ colorTheme: 'mint' })
        userId.value = '8'
        queue.reset('8')
        calls[0].resolve({ ok: true, profile: profile({ theme: 'dark' }, '9') })
        await tick()

        await expect(first).resolves.toEqual({ status: 'dropped' })
        expect(applyProfile).not.toHaveBeenCalled()
        expect(calls).toHaveLength(1)
        expect(queue.pending).toEqual({})
    })

    it('a failure of the previous account after the switch is ignored too', async () => {
        const { queue, calls, userId } = setup('7')

        void queue.change({ theme: 'dark' })
        userId.value = '8'
        queue.reset('8')
        calls[0].resolve({ ok: false, kind: 'error', message: 'down' })
        await tick()

        expect(queue.lastFailure.value).toBeNull()
    })

    it('never sends for a user other than the one the queue was made for', async () => {
        const { queue, calls, userId } = setup('7')

        // The account changed and nobody reset the queue yet.
        userId.value = '8'
        const outcome = queue.change({ theme: 'dark' })

        await expect(outcome).resolves.toEqual({ status: 'dropped' })
        expect(calls).toHaveLength(0)
    })

    it('a change pending when the account changes is dropped at the flush, not sent', async () => {
        const { queue, calls, userId } = setup('7')

        void queue.change({ fontSize: 17 }, { delayMs: 600 })
        userId.value = '8'
        await vi.advanceTimersByTimeAsync(600)

        expect(calls).toHaveLength(0)
        expect(queue.ownerId()).toBe('8')
        expect(queue.pending).toEqual({})
    })

    it('a 401 stops the queue', async () => {
        const { queue, calls } = setup()

        const outcome = queue.change({ theme: 'dark' })
        void queue.change({ colorTheme: 'mint' })
        calls[0].resolve({ ok: false, kind: 'unauthorized', message: 'Session expired' })

        await expect(outcome).resolves.toMatchObject({ kind: 'unauthorized' })
        await tick()
        expect(calls).toHaveLength(1)
        expect(queue.ownerId()).toBeNull()
        await expect(queue.change({ theme: 'light' })).resolves.toEqual({ status: 'dropped' })
    })
})
