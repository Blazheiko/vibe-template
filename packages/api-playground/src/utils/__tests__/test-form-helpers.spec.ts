import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatResponseBody, scrollToResponse } from '../test-form-helpers'

// feat-076 (J): what both test forms (HTTP and WebSocket) do with a response.

describe('formatResponseBody', () => {
    it.each([
        [undefined, ''],
        ['plain text', 'plain text'],
        ['', ''],
        [{ a: 1 }, '{\n  "a": 1\n}'],
        [null, 'null'],
        [5, '5'],
    ])('%j -> %j', (data, expected) => {
        expect(formatResponseBody(data)).toBe(expected)
    })
})

describe('scrollToResponse', () => {
    const elements = new Map<string, unknown>()
    let container: unknown = null
    const fakeDocument = {
        getElementById: (id: string) => elements.get(id) ?? null,
        querySelector: (selector: string) =>
            selector === '.test-workspace-scroll' ? container : null,
    }

    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis) })
        vi.stubGlobal('document', fakeDocument)
        elements.clear()
        container = null
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('scrolls the pane so the body is 96 px under its top, after the render, smoothly', async () => {
        const scrollTo = vi.fn()
        container = { scrollTop: 200, getBoundingClientRect: () => ({ top: 50 }), scrollTo }
        elements.set('body', { getBoundingClientRect: () => ({ top: 400 }) })
        const done = scrollToResponse('body', 'section')
        await vi.advanceTimersByTimeAsync(0)
        await done
        expect(scrollTo).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(120)
        expect(scrollTo).toHaveBeenCalledWith({ top: 200 + 400 - 50 - 96, behavior: 'smooth' })
    })

    it('falls back to the section when there is no body, and never scrolls above the top', async () => {
        const scrollTo = vi.fn()
        container = { scrollTop: 0, getBoundingClientRect: () => ({ top: 50 }), scrollTo }
        elements.set('section', { getBoundingClientRect: () => ({ top: 60 }) })
        await scrollToResponse('body', 'section')
        await vi.advanceTimersByTimeAsync(120)
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    })

    it('scrolls the element into view when there is no pane', async () => {
        const scrollIntoView = vi.fn()
        elements.set('body', { scrollIntoView })
        await scrollToResponse('body', 'section')
        await vi.advanceTimersByTimeAsync(120)
        expect(scrollIntoView).toHaveBeenCalledWith({
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest',
        })
    })

    it('does nothing when neither element is there', async () => {
        const scrollTo = vi.fn()
        container = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), scrollTo }
        await scrollToResponse('body', 'section')
        await vi.advanceTimersByTimeAsync(120)
        expect(scrollTo).not.toHaveBeenCalled()
    })
})
