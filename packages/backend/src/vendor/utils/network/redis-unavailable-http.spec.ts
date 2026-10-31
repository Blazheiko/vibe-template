import type { HttpResponse } from 'uWebSockets.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

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

const ORIGINAL_APP_ENV = process.env['APP_ENV']
afterAll(() => {
    if (ORIGINAL_APP_ENV === undefined) delete process.env['APP_ENV']
    else process.env['APP_ENV'] = ORIGINAL_APP_ENV
})

const IOREDIS_TEXT = 'Command timed out'

describe.each(['prod', 'local'])('handleError for RedisUnavailableError (APP_ENV=%s)', (env) => {
    it('answers 503 service_unavailable with Retry-After and no ioredis text', async () => {
        vi.resetModules()
        vi.clearAllMocks()
        process.env['APP_ENV'] = env
        const { handleError } = await import('#vendor/start/server.js')
        const { RedisUnavailableError } = await import('./errors/redis-unavailable-error.js')
        const status: string[] = []
        const headers = new Map<string, string>()
        let body = ''
        const res = {
            cork: (cb: () => void) => {
                cb()
                return res
            },
            writeStatus: (value: string) => {
                status.push(value)
                return res
            },
            writeHeader: (name: string, value: string) => {
                headers.set(name, value)
                return res
            },
            end: (value: string) => {
                body = value
                return res
            },
        } as unknown as HttpResponse
        const error = new RedisUnavailableError('Redis command failed', {
            cause: new Error(IOREDIS_TEXT),
        })

        handleError(res, error)

        expect(status).toEqual(['503 Service Unavailable'])
        expect(headers.get('Retry-After')).toBe('1')
        expect(JSON.parse(body)).toEqual({
            status: 'error',
            code: 'service_unavailable',
            message: 'Service temporarily unavailable. Try again later.',
        })
        expect(body).not.toContain(IOREDIS_TEXT)
        // Error level with the typed err: the Sentry transport skips it by err.type.
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: error }),
            'Request failed: Redis unavailable',
        )
    })
})

// ADR 0002: the sessionToken lookup (database) could not answer. The request is not
// served on the strength of the Redis record alone.
describe('handleError for SessionVerificationUnavailableError', () => {
    it('answers 503 service_unavailable with Retry-After and no driver text', async () => {
        vi.resetModules()
        vi.clearAllMocks()
        process.env['APP_ENV'] = 'prod'
        const { handleError } = await import('#vendor/start/server.js')
        const { SessionVerificationUnavailableError } =
            await import('./errors/session-verification-unavailable-error.js')
        const status: string[] = []
        const headers = new Map<string, string>()
        let body = ''
        const res = {
            cork: (cb: () => void) => {
                cb()
                return res
            },
            writeStatus: (value: string) => {
                status.push(value)
                return res
            },
            writeHeader: (name: string, value: string) => {
                headers.set(name, value)
                return res
            },
            end: (value: string) => {
                body = value
                return res
            },
        } as unknown as HttpResponse
        const error = new SessionVerificationUnavailableError('lookup failed', {
            cause: new Error('connection terminated unexpectedly'),
        })

        handleError(res, error)

        expect(status).toEqual(['503 Service Unavailable'])
        expect(headers.get('Retry-After')).toBe('1')
        expect(JSON.parse(body)).toEqual({
            status: 'error',
            code: 'service_unavailable',
            message: 'Service temporarily unavailable. Try again later.',
        })
        expect(body).not.toMatch(/connection terminated|lookup failed/)
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: error }),
            'Request failed: session verification unavailable',
        )
    })
})
