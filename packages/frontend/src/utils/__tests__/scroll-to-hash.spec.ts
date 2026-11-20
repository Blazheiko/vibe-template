import { afterEach, describe, expect, it, vi } from 'vitest'

import { scrollToHash } from '../scroll-to-hash'

// feat-236 (Р7): `/account#sessions` scrolls to the section once it is there.
afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
})

describe('scrollToHash', () => {
    it('no fragment: no scrolling', async () => {
        await expect(scrollToHash('')).resolves.toBe(false)
        await expect(scrollToHash('#')).resolves.toBe(false)
    })

    it('waits for a section that appears later, then scrolls to it', async () => {
        vi.useFakeTimers()
        const result = scrollToHash('#sessions')
        await vi.advanceTimersByTimeAsync(200)
        const section = document.createElement('section')
        section.id = 'sessions'
        const scrollIntoView = vi.fn()
        section.scrollIntoView = scrollIntoView
        document.body.append(section)
        await vi.advanceTimersByTimeAsync(100)
        await expect(result).resolves.toBe(true)
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    })

    it('gives up after the wait, and on a fragment that is no selector', async () => {
        vi.useFakeTimers()
        const missing = scrollToHash('#nothing', { waitMs: 500 })
        await vi.advanceTimersByTimeAsync(600)
        await expect(missing).resolves.toBe(false)
        const bad = scrollToHash('#1abc', { waitMs: 100 })
        await vi.advanceTimersByTimeAsync(200)
        await expect(bad).resolves.toBe(false)
    })
})
