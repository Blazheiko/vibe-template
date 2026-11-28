import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { defineComponent } from 'vue'

import {
    attemptKey,
    chunkLoadNotice,
    decideRecovery,
    installPreloadRecovery,
    isChunkLoadError,
    type RecoveryDeps,
    type RecoveryEnv,
} from '../preload-recovery'

const Page = defineComponent({ template: '<div />' })
const chunkError = () =>
    new TypeError('Failed to fetch dynamically imported module: /assets/Page.js')

function memoryStorage(): Storage {
    const data = new Map<string, string>()
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
        clear: () => {
            data.clear()
        },
        key: () => null,
        get length() {
            return data.size
        },
    }
}

interface Harness {
    router: Router
    deps: RecoveryDeps & {
        navigate: ReturnType<typeof vi.fn>
        report: ReturnType<typeof vi.fn>
    }
    env: RecoveryEnv
    fireOnline: () => void
    firePreloadError: () => { prevented: boolean }
}

function harness(lazy: () => Promise<unknown>, env: Partial<RecoveryEnv> = {}): Harness {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: Page },
            { path: '/account', component: lazy as never },
        ],
    })
    const fullEnv: RecoveryEnv = {
        onLine: true,
        storage: memoryStorage(),
        buildTimestamp: 'A',
        ...env,
    }
    let online: (() => void) | undefined
    let windowListener: ((event: Event & { payload?: unknown }) => void) | undefined
    const deps = {
        env: () => fullEnv,
        navigate: vi.fn(),
        onceOnline: (callback: () => void) => {
            online = callback
        },
        report: vi.fn(),
        addWindowListener: (listener: (event: Event & { payload?: unknown }) => void) => {
            windowListener = listener
        },
        currentUrl: () => ({ href: 'https://app.test/account#avatar', path: '/account' }),
    }
    installPreloadRecovery(router, deps)
    return {
        router,
        deps,
        env: fullEnv,
        fireOnline: () => online?.(),
        firePreloadError: () => {
            const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
                payload: chunkError(),
            })
            windowListener?.(event)
            return { prevented: event.defaultPrevented }
        },
    }
}

afterEach(() => {
    chunkLoadNotice.value = null
})

describe('isChunkLoadError', () => {
    it('recognises the messages of Chromium, Firefox, Safari and Vite', () => {
        for (const message of [
            'Failed to fetch dynamically imported module: https://x/a.js',
            'error loading dynamically imported module: https://x/a.js',
            'Importing a module script failed.',
            'Unable to preload CSS for /assets/a.css',
        ]) {
            expect(isChunkLoadError(new TypeError(message))).toBe(true)
        }
        expect(isChunkLoadError(new Error('Network request failed'))).toBe(false)
        expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
    })
})

describe('decideRecovery', () => {
    const env = (overrides: Partial<RecoveryEnv> = {}): RecoveryEnv => ({
        onLine: true,
        storage: memoryStorage(),
        buildTimestamp: 'A',
        ...overrides,
    })

    it('reloads once per page and build, then gives up', () => {
        const shared = env()
        expect(decideRecovery('/account', shared)).toBe('reload')
        expect(decideRecovery('/account', shared)).toBe('gave-up')
        expect(decideRecovery('/support', shared)).toBe('reload')
        expect(decideRecovery('/account', { ...shared, buildTimestamp: 'B' })).toBe('reload')
    })

    it('waits for the network when offline and does not mark an attempt', () => {
        const shared = env({ onLine: false })
        expect(decideRecovery('/account', shared)).toBe('wait-online')
        expect(decideRecovery('/account', { ...shared, onLine: true })).toBe('reload')
    })

    it('leaves the reload to the user without storage for the loop guard', () => {
        expect(decideRecovery('/account', env({ storage: null }))).toBe('manual')
        const throwing = {
            getItem: () => {
                throw new Error('SecurityError')
            },
            setItem: () => undefined,
            removeItem: () => undefined,
        }
        expect(decideRecovery('/account', env({ storage: throwing }))).toBe('manual')
    })

    it('keys the attempt by the path, never by the query', () => {
        expect(attemptKey('/reset-password', 'A')).toBe('chunk-reload:A:/reset-password')
        expect(attemptKey('/reset-password', 'A')).not.toContain('token')
    })
})

describe('installPreloadRecovery', () => {
    it('reloads to the target of the navigation, not to the current address', async () => {
        const { router, deps } = harness(() => Promise.reject(chunkError()))
        await router.push('/')
        await router.push('/account?tab=security').catch(() => undefined)
        expect(deps.navigate).toHaveBeenCalledExactlyOnceWith('/account?tab=security')
        expect(deps.report).not.toHaveBeenCalled()
        expect(router.currentRoute.value.path).toBe('/')
    })

    it('does not reload from the window listener while a navigation is in flight', async () => {
        // The import fires vite:preloadError first, as Vite does, then rejects.
        const fire: { event?: () => { prevented: boolean } } = {}
        let result: { prevented: boolean } | undefined
        const { router, deps, firePreloadError } = harness(() => {
            result = fire.event?.()
            return Promise.reject(chunkError())
        })
        fire.event = firePreloadError
        await router.push('/')
        await router.push('/account').catch(() => undefined)
        expect(result).toEqual({ prevented: false })
        expect(deps.navigate).toHaveBeenCalledExactlyOnceWith('/account')
    })

    it('reloads the current address for an import outside a navigation', async () => {
        const { router, deps, firePreloadError } = harness(() => Promise.resolve(Page))
        await router.push('/')
        expect(firePreloadError()).toEqual({ prevented: true })
        expect(deps.navigate).toHaveBeenCalledExactlyOnceWith('https://app.test/account#avatar')
    })

    it('gives up after a reload that did not help: a notice and one report', async () => {
        const { router, deps, env } = harness(() => Promise.reject(chunkError()))
        env.storage?.setItem(attemptKey('/account', 'A'), '1')
        await router.push('/')
        await router.push('/account').catch(() => undefined)
        expect(deps.navigate).not.toHaveBeenCalled()
        expect(deps.report).toHaveBeenCalledOnce()
        expect(chunkLoadNotice.value).toEqual({ kind: 'failed', target: '/account' })
    })

    it('waits offline and reloads when the network is back', async () => {
        const { router, deps, env, fireOnline } = harness(() => Promise.reject(chunkError()), {
            onLine: false,
        })
        await router.push('/')
        await router.push('/account').catch(() => undefined)
        expect(deps.navigate).not.toHaveBeenCalled()
        expect(chunkLoadNotice.value).toEqual({ kind: 'offline', target: '/account' })
        env.onLine = true
        fireOnline()
        expect(deps.navigate).toHaveBeenCalledExactlyOnceWith('/account')
    })

    it('does not reload to the old target once the user navigated elsewhere', async () => {
        const { router, deps, env, fireOnline } = harness(() => Promise.reject(chunkError()), {
            onLine: false,
        })
        await router.push('/account').catch(() => undefined)
        await router.push('/')
        expect(chunkLoadNotice.value).toBeNull()
        env.onLine = true
        fireOnline()
        expect(deps.navigate).not.toHaveBeenCalled()
    })

    it('never reloads by itself without sessionStorage', async () => {
        const { router, deps } = harness(() => Promise.reject(chunkError()), { storage: null })
        await router.push('/')
        await router.push('/account').catch(() => undefined)
        expect(deps.navigate).not.toHaveBeenCalled()
        expect(deps.report).not.toHaveBeenCalled()
        expect(chunkLoadNotice.value).toEqual({ kind: 'failed', target: '/account' })
    })

    it('clears the attempt and the notice after a successful navigation', async () => {
        const { router, env } = harness(() => Promise.resolve(Page))
        env.storage?.setItem(attemptKey('/account', 'A'), '1')
        chunkLoadNotice.value = { kind: 'failed', target: '/account' }
        await router.push('/account')
        expect(env.storage?.getItem(attemptKey('/account', 'A'))).toBeNull()
        expect(chunkLoadNotice.value).toBeNull()
    })

    it('ignores other navigation errors', async () => {
        const { router, deps } = harness(() => Promise.reject(new Error('boom')))
        await router.push('/')
        await router.push('/account').catch(() => undefined)
        expect(deps.navigate).not.toHaveBeenCalled()
        expect(chunkLoadNotice.value).toBeNull()
    })
})
