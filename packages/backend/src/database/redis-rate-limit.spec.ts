import { describe, expect, it, vi } from 'vitest'

const constructed: unknown[] = []
const handlers = new Map<string, (err: unknown) => void>()
const disconnect = vi.fn()
const connect = vi.fn(async () => {})

vi.mock('ioredis', () => ({
    Redis: vi.fn(function (this: unknown, options: unknown) {
        constructed.push(options)
        return {
            on: (event: string, handler: (err: unknown) => void) => {
                handlers.set(event, handler)
            },
            disconnect,
            connect,
        }
    }),
}))

const warn = vi.fn()
vi.mock('#logger', () => ({ default: { warn } }))

const { rateLimitRedisOptions, __rateLimitRedisTestHooks } = await import('./redis-rate-limit.js')

describe('rate-limit Redis client', () => {
    it('is created with strict, no-resend options on the shared server', () => {
        expect(constructed).toHaveLength(1)
        expect(constructed[0]).toMatchObject({
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 0,
            autoResendUnfulfilledCommands: false,
            commandTimeout: 500,
        })
        expect(rateLimitRedisOptions.host).toBeTypeOf('string')
        expect(rateLimitRedisOptions.retryStrategy(1)).toBe(200)
        expect(rateLimitRedisOptions.retryStrategy(100)).toBe(2000)
    })

    it('logs connection errors at most once a minute', () => {
        const onError = handlers.get('error')
        onError?.(new Error('a'))
        onError?.(new Error('b'))
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('test hooks disconnect without auto-reconnect and connect again', async () => {
        __rateLimitRedisTestHooks.forceDisconnect()
        expect(disconnect).toHaveBeenCalledWith(false)
        await __rateLimitRedisTestHooks.reconnect()
        expect(connect).toHaveBeenCalled()
    })
})
