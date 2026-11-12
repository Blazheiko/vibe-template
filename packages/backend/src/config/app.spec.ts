import { afterEach, describe, expect, it, vi } from 'vitest'

// Real #config/app.js (no mock): each test sets the env, resets the module
// registry and imports the config again, since it is read once at import.

const NAME = 'APP_MAX_JSON_BODY_SIZE'
const DEFAULT = 2_097_152
const original = process.env[NAME]

const loadJsonLimit = async (value: string): Promise<number> => {
    process.env[NAME] = value
    vi.resetModules()
    const { default: config } = await import('./app.js')
    return config.maxJsonBodySize
}

afterEach(() => {
    if (original === undefined) delete process.env[NAME]
    else process.env[NAME] = original
})

describe('parseSize via APP_MAX_JSON_BODY_SIZE', () => {
    it('accepts a positive integer number of bytes', async () => {
        expect(await loadJsonLimit('1024')).toBe(1024)
    })

    it('ignores surrounding whitespace', async () => {
        expect(await loadJsonLimit(' 12 ')).toBe(12)
    })

    it.each(['abc', '', '0', '-1', '1.5', '1e6', 'Infinity', '9007199254740993', '0x10', '1 024'])(
        'falls back to the default for %j',
        async (value) => {
            expect(await loadJsonLimit(value)).toBe(DEFAULT)
        },
    )
})

describe('APP_UNIX_PATH', () => {
    const originalUnixPath = process.env['APP_UNIX_PATH']

    const loadUnixPath = async (value: string | undefined): Promise<string | undefined> => {
        if (value === undefined) delete process.env['APP_UNIX_PATH']
        else process.env['APP_UNIX_PATH'] = value
        vi.resetModules()
        const { default: config } = await import('./app.js')
        return config.unixPath
    }

    afterEach(() => {
        if (originalUnixPath === undefined) delete process.env['APP_UNIX_PATH']
        else process.env['APP_UNIX_PATH'] = originalUnixPath
    })

    it('is undefined when unset, so the server listens on HOST:PORT', async () => {
        expect(await loadUnixPath(undefined)).toBeUndefined()
    })

    it('is undefined for an empty value copied from .env.example', async () => {
        expect(await loadUnixPath('')).toBeUndefined()
    })

    it('keeps a configured socket path', async () => {
        expect(await loadUnixPath('/tmp/app.sock')).toBe('/tmp/app.sock')
    })
})

// feat-192: the frontend and shared/dev-backend read an empty API_PATH_PREFIX as `api`, so the
// backend must too, or the dev proxy and the compiled prefix would miss its routes.
describe('API_PATH_PREFIX', () => {
    const originalPrefix = process.env['API_PATH_PREFIX']

    const loadPrefix = async (value: string | undefined): Promise<string> => {
        if (value === undefined) delete process.env['API_PATH_PREFIX']
        else process.env['API_PATH_PREFIX'] = value
        vi.resetModules()
        const { default: config } = await import('./app.js')
        return config.pathPrefix
    }

    afterEach(() => {
        if (originalPrefix === undefined) delete process.env['API_PATH_PREFIX']
        else process.env['API_PATH_PREFIX'] = originalPrefix
    })

    it.each([undefined, '', '  '])('is api for %j', async (value) => {
        expect(await loadPrefix(value)).toBe('api')
    })

    it('keeps a configured prefix without its outer slashes', async () => {
        expect(await loadPrefix('/v1/')).toBe('v1')
    })
})
