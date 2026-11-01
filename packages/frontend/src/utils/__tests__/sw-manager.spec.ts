import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createServiceWorkerError,
    createUpdateNotifier,
    isServiceWorkerErrorPayload,
    isServiceWorkerVersionMessage,
    parseBuildTimestamp,
    requestWorkerBuildTimestamp,
    startServiceWorker,
} from '../sw-manager'

// feat-076 (J): what main.ts used to do about its service worker, as a module that can be tested.

const MIN = 60_000
const APP = 1_700_000_000_000

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

describe('parseBuildTimestamp', () => {
    it.each([
        ['1700000000000', 1_700_000_000_000],
        [1_700_000_000_000, 1_700_000_000_000],
        ['abc', null],
        ['0', null],
        ['-5', null],
        [undefined, null],
        [null, null],
        [{}, null],
    ])('%j -> %j', (value, expected) => {
        expect(parseBuildTimestamp(value)).toBe(expected)
    })
})

describe('the messages of the worker', () => {
    it('recognises an error message by its type and an object `err`', () => {
        expect(isServiceWorkerErrorPayload({ type: 'SW_ERROR', err: { message: 'x' } })).toBe(true)
        expect(isServiceWorkerErrorPayload({ type: 'SW_ERROR', err: null })).toBe(false)
        expect(isServiceWorkerErrorPayload({ type: 'SW_ERROR', err: 'x' })).toBe(false)
        expect(isServiceWorkerErrorPayload({ type: 'OTHER', err: {} })).toBe(false)
        expect(isServiceWorkerErrorPayload('NEW_VERSION')).toBe(false)
        expect(isServiceWorkerErrorPayload(null)).toBe(false)
    })

    it('turns the error of a worker into an Error with what it sent', () => {
        const fromObject = createServiceWorkerError({
            message: 'boom',
            name: 'TypeError',
            stack: 's',
        })
        expect(fromObject.error.message).toBe('boom')
        expect(fromObject.error.name).toBe('TypeError')
        expect(fromObject.error.stack).toBe('s')
        expect(fromObject.extra).toEqual({ swStack: 's', swName: 'TypeError' })

        const bare = createServiceWorkerError({})
        expect(bare.error.message).toBe('Service worker error')
        expect(bare.extra).toEqual({ swStack: undefined, swName: undefined })

        const real = new Error('real')
        expect(createServiceWorkerError(real)).toEqual({ error: real, extra: {} })
    })

    it('recognises a version message only with a usable build time', () => {
        expect(isServiceWorkerVersionMessage({ type: 'BUILD_INFO', buildTimestamp: '5' })).toBe(
            true,
        )
        expect(isServiceWorkerVersionMessage({ type: 'NEW_VERSION', buildTimestamp: 5 })).toBe(true)
        expect(isServiceWorkerVersionMessage({ type: 'NEW_VERSION', buildTimestamp: 'x' })).toBe(
            false,
        )
        expect(isServiceWorkerVersionMessage({ type: 'NEW_VERSION' })).toBe(false)
        expect(isServiceWorkerVersionMessage('NEW_VERSION')).toBe(false)
    })
})

describe('requestWorkerBuildTimestamp', () => {
    it('is null without a worker', async () => {
        expect(await requestWorkerBuildTimestamp(null)).toBeNull()
    })

    it('asks the worker over a message channel and reads its answer', async () => {
        const worker = {
            postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
                ports[0]?.postMessage({ type: 'BUILD_INFO', buildTimestamp: '1700000999000' })
            }),
        } as unknown as ServiceWorker
        expect(await requestWorkerBuildTimestamp(worker)).toBe(1_700_000_999_000)
        expect((worker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
            type: 'GET_BUILD_TIMESTAMP',
        })
    })

    it('is null for an answer that is not a version message', async () => {
        const worker = {
            postMessage: (_message: unknown, ports: MessagePort[]) => {
                ports[0]?.postMessage({ type: 'BUILD_INFO' })
            },
        } as unknown as ServiceWorker
        expect(await requestWorkerBuildTimestamp(worker)).toBeNull()
    })

    it('gives up after a second without an answer', async () => {
        vi.useFakeTimers()
        const worker = { postMessage: vi.fn() } as unknown as ServiceWorker
        const pending = requestWorkerBuildTimestamp(worker)
        await vi.advanceTimersByTimeAsync(1000)
        expect(await pending).toBeNull()
    })

    it('is null when the worker cannot be posted to', async () => {
        const worker = {
            postMessage: () => {
                throw new Error('gone')
            },
        } as unknown as ServiceWorker
        expect(await requestWorkerBuildTimestamp(worker)).toBeNull()
    })
})

describe('createUpdateNotifier', () => {
    const build = (over: Partial<Parameters<typeof createUpdateNotifier>[0]> = {}) => {
        const announce = vi.fn()
        const read = vi.fn().mockResolvedValue(APP + 30 * MIN)
        const notify = createUpdateNotifier({
            hadActiveController: true,
            appBuildTimestamp: APP,
            readWorkerBuildTimestamp: read,
            announce,
            ...over,
        })
        return { notify, announce, read }
    }

    it('tells the user when the worker is more than ten minutes newer than the page', async () => {
        const { notify, announce, read } = build()
        await notify('installed', null)
        expect(announce).toHaveBeenCalledTimes(1)
        expect(read).toHaveBeenCalledTimes(1)
    })

    it('is silent for a first install: no worker controlled the page when it loaded', async () => {
        const { notify, announce, read } = build({ hadActiveController: false })
        await notify('installed', null)
        expect(announce).not.toHaveBeenCalled()
        expect(read).not.toHaveBeenCalled()
    })

    it('is silent when the worker is at most ten minutes newer: it is the same release', async () => {
        const { notify, announce } = build({
            readWorkerBuildTimestamp: vi.fn().mockResolvedValue(APP + 10 * MIN),
        })
        await notify('installed', null)
        expect(announce).not.toHaveBeenCalled()
    })

    it('is silent when the page has no usable build time, or the worker cannot say its own', async () => {
        const noApp = build({ appBuildTimestamp: null })
        await noApp.notify('installed', null)
        expect(noApp.announce).not.toHaveBeenCalled()

        const noWorker = build({ readWorkerBuildTimestamp: vi.fn().mockResolvedValue(null) })
        await noWorker.notify('installed', null)
        expect(noWorker.announce).not.toHaveBeenCalled()
    })

    it('uses the build time the message carried and does not ask the worker', async () => {
        const { notify, announce, read } = build()
        await notify('message', null, APP + 60 * MIN)
        expect(read).not.toHaveBeenCalled()
        expect(announce).toHaveBeenCalledTimes(1)
    })

    it('tells at most once, however many signals arrive', async () => {
        const { notify, announce } = build()
        await notify('waiting', null)
        await notify('controllerchange', null)
        await notify('message', null, APP + 60 * MIN)
        expect(announce).toHaveBeenCalledTimes(1)
    })

    it('tells once even when two signals are both waiting for the worker', async () => {
        let release: (value: number) => void = () => undefined
        const slow = new Promise<number>((resolve) => {
            release = resolve
        })
        const { notify, announce } = build({ readWorkerBuildTimestamp: () => slow })
        const first = notify('installed', null)
        const second = notify('controllerchange', null)
        release(APP + 30 * MIN)
        await Promise.all([first, second])
        expect(announce).toHaveBeenCalledTimes(1)
    })
})

describe('startServiceWorker', () => {
    function stubWorkerHost() {
        const listeners = new Map<string, (event: unknown) => void>()
        vi.stubGlobal('navigator', {
            serviceWorker: {
                controller: {},
                addEventListener: (type: string, listener: (event: unknown) => void) => {
                    listeners.set(type, listener)
                },
                getRegistrations: vi.fn().mockResolvedValue([]),
            },
        })
        return listeners
    }

    it('passes an error of the worker to Sentry, and announces a version message that is newer', async () => {
        vi.stubEnv('PROD', true)
        const listeners = stubWorkerHost()
        const reportError = vi.fn()
        const announceUpdate = vi.fn()

        startServiceWorker({ appBuildTimestamp: String(APP), reportError, announceUpdate })
        const onMessage = listeners.get('message')!

        onMessage({ data: { type: 'SW_ERROR', err: { message: 'boom', name: 'Error' } } })
        expect(reportError).toHaveBeenCalledTimes(1)
        expect(reportError.mock.calls[0]?.[0]).toMatchObject({ message: 'boom' })

        onMessage({ data: 'NEW_VERSION' })
        onMessage({ data: { type: 'NEW_VERSION', buildTimestamp: String(APP + 30 * MIN) } })
        await vi.waitFor(() => {
            expect(announceUpdate).toHaveBeenCalledTimes(1)
        })
    })

    it('does not listen at all outside production', () => {
        vi.stubEnv('PROD', false)
        const listeners = stubWorkerHost()
        startServiceWorker({
            appBuildTimestamp: String(APP),
            reportError: vi.fn(),
            announceUpdate: vi.fn(),
        })
        expect(listeners.size).toBe(0)
    })
})
