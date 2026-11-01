import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F4 (feat-068): the playground lets a developer type an Authorization header or a cookie to try
// the API. Those values must not be written to localStorage, where they outlive the tab, are
// shared by every script of the origin and survive for ever; sessionStorage lasts one tab.

const STORAGE_KEY = 'api-settings'

async function freshStore() {
    vi.resetModules()
    setActivePinia(createPinia())
    const { useApiSettingsStore } = await import('../api-settings')
    return useApiSettingsStore()
}

// The package has no DOM environment: the two storages are plain in-memory ones.
const memoryStorage = (): Storage => {
    const data = new Map<string, string>()
    return {
        get length() {
            return data.size
        },
        clear: () => {
            data.clear()
        },
        getItem: (key) => data.get(key) ?? null,
        key: (index) => [...data.keys()][index] ?? null,
        removeItem: (key) => {
            data.delete(key)
        },
        setItem: (key, value) => {
            data.set(key, value)
        },
    }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('the playground settings store', () => {
    it('keeps header values out of localStorage', async () => {
        const store = await freshStore()

        store.addGlobalHeader('Authorization', 'Bearer secret-token-123')
        store.addGlobalHeader('Cookie', 'session=abc')
        store.addGlobalHeader('X-Api-Key', 'key-456')

        expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('secret-token-123')
        expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('session=abc')
        expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('key-456')
    })

    it('keeps them in sessionStorage, for this tab', async () => {
        const store = await freshStore()

        store.addGlobalHeader('Authorization', 'Bearer secret-token-123')

        expect(sessionStorage.getItem(STORAGE_KEY) ?? '').toContain('secret-token-123')
    })

    it('still remembers the other settings across tabs (localStorage)', async () => {
        const store = await freshStore()
        store.setBaseUrl('https://api.example.test')
        store.setPathPrefix('v2')

        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
            baseUrl?: string
            pathPrefix?: string
            enableGlobalHeaders?: boolean
        }

        expect(saved.baseUrl).toBe('https://api.example.test')
        expect(saved.pathPrefix).toBe('v2')
        expect(saved.enableGlobalHeaders).toBe(true)
    })

    it('restores header values in the same tab', async () => {
        const first = await freshStore()
        first.addGlobalHeader('Authorization', 'Bearer secret-token-123')

        const second = await freshStore()

        expect(second.globalHeaders).toEqual({ Authorization: 'Bearer secret-token-123' })
    })

    it('does not bring header values back from localStorage (an older version wrote them there)', async () => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                baseUrl: 'https://api.example.test',
                globalHeaders: { Authorization: 'Bearer leftover' },
                enableGlobalHeaders: true,
            }),
        )

        const store = await freshStore()

        expect(store.globalHeaders).toEqual({})
        // …and the leftover is wiped from the place it should never have been.
        expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('leftover')
    })

    it('does not log header values', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const store = await freshStore()

        store.addGlobalHeader('Authorization', 'Bearer secret-token-123')

        expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token-123')
    })

    it('clears the header values on reset', async () => {
        const store = await freshStore()
        store.addGlobalHeader('Authorization', 'Bearer secret-token-123')

        store.resetToDefaults()

        expect(sessionStorage.getItem(STORAGE_KEY) ?? '').not.toContain('secret-token-123')
        expect(store.globalHeaders).toEqual({})
    })
})
