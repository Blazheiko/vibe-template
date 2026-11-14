import type { HttpResponse } from 'uWebSockets.js'
import { describe, expect, it, vi } from 'vitest'

import { MalformedBodyError } from './errors/malformed-body-error.js'

const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    // handleError logs through logger.child(...) bound to the request.
    child: vi.fn((): unknown => logger),
}
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('uWebSockets.js', () => ({ App: () => ({}), getParts: vi.fn() }))
vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
vi.mock('#vendor/utils/network/ws-handlers.js', () => ({
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    handleUpgrade: vi.fn(),
    closeAllWs: vi.fn(),
}))
vi.mock('#vendor/start/static-server.js', () => ({
    cacheStaticSource: vi.fn().mockResolvedValue(null),
    staticHandler: vi.fn(),
    staticCacheHandler: vi.fn(),
}))
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))

const SECRET = 'hunter2secret'

const sendBody = async (body: string): Promise<unknown> => {
    const { getData } = await import('./http-request-handlers.js')
    const res = {
        onData: (cb: (chunk: ArrayBuffer, isLast: boolean) => void) => {
            const bytes = new TextEncoder().encode(body)
            cb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true)
            return res
        },
    }
    return getData(
        res as never,
        'application/json',
        new Map(),
        1_000_000,
        { aborted: false },
        '127.0.0.1',
    ).catch((err: unknown) => err)
}

describe('malformed JSON body', () => {
    it.each([`"${SECRET}`, SECRET, `{"password":"${SECRET}" x`, `["${SECRET}"]`])(
        'throws MalformedBodyError without quoting the body: %s',
        async (body) => {
            const error = await sendBody(body)
            expect(error).toBeInstanceOf(MalformedBodyError)
            expect(JSON.stringify(error)).not.toContain(SECRET)
            expect(String(error)).not.toContain(SECRET)
            expect((error as Error).cause).toBeUndefined()
        },
    )
})

describe('handleError for MalformedBodyError', () => {
    it('answers 400 bad_request and only warns (nothing for Sentry)', async () => {
        const { handleError } = await import('#vendor/start/server.js')
        const calls: string[] = []
        const res = {
            cork: (cb: () => void) => {
                cb()
                return res
            },
            writeStatus: (status: string) => {
                calls.push(status)
                return res
            },
            writeHeader: () => res,
            end: (body: string) => {
                calls.push(body)
                return res
            },
        } as unknown as HttpResponse

        handleError(res, new MalformedBodyError('json'))

        expect(calls[0]).toBe('400 Bad Request')
        expect(calls.at(-1)).toContain('"code":"bad_request"')
        expect(logger.warn).toHaveBeenCalledWith({ bodyKind: 'json' }, 'Malformed request body')
        expect(logger.error).not.toHaveBeenCalled()
    })
})
