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

// feat-202: what a JSON route takes without a limit of its own.
describe('APP_DEFAULT_JSON_BODY_SIZE', () => {
    const original = process.env['APP_DEFAULT_JSON_BODY_SIZE']
    const load = async (value: string | undefined): Promise<number> => {
        if (value === undefined) delete process.env['APP_DEFAULT_JSON_BODY_SIZE']
        else process.env['APP_DEFAULT_JSON_BODY_SIZE'] = value
        vi.resetModules()
        const { default: config } = await import('./app.js')
        return config.defaultJsonBodySize
    }
    afterEach(() => {
        if (original === undefined) delete process.env['APP_DEFAULT_JSON_BODY_SIZE']
        else process.env['APP_DEFAULT_JSON_BODY_SIZE'] = original
    })

    it('defaults to 100 KB', async () => {
        expect(await load(undefined)).toBe(102_400)
    })

    it('reads a number of bytes and falls back to the default for anything else', async () => {
        expect(await load('4096')).toBe(4096)
        expect(await load('0')).toBe(102_400)
        expect(await load('abc')).toBe(102_400)
    })
})

// feat-201: the in-flight body budget. Unlike the size limits, `0` is a value: it switches
// the limit off.
describe('APP_MAX_INFLIGHT_BODY_BYTES and APP_MAX_INFLIGHT_BODY_BYTES_PER_IP', () => {
    const names = ['APP_MAX_INFLIGHT_BODY_BYTES', 'APP_MAX_INFLIGHT_BODY_BYTES_PER_IP'] as const
    const originals = names.map((name) => process.env[name])

    const load = async (total: string | undefined, perIp: string | undefined) => {
        for (const [name, value] of [
            [names[0], total],
            [names[1], perIp],
        ] as const) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
        vi.resetModules()
        const { default: config } = await import('./app.js')
        return [config.maxInFlightBodyBytes, config.maxInFlightBodyBytesPerIp]
    }

    afterEach(() => {
        names.forEach((name, index) => {
            const value = originals[index]
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        })
    })

    it('default to 256 MiB in total and 64 MiB per address', async () => {
        expect(await load(undefined, undefined)).toEqual([268_435_456, 67_108_864])
    })

    it('read a number of bytes', async () => {
        expect(await load('1000', ' 200 ')).toEqual([1000, 200])
    })

    it('0 switches a limit off', async () => {
        expect(await load('0', '00')).toEqual([0, 0])
    })

    it.each(['abc', '', '-1', '1.5', '1e6'])('fall back to the default for %j', async (value) => {
        expect(await load(value, value)).toEqual([268_435_456, 67_108_864])
    })
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

// feat-192/193: the backend reads API_PATH_PREFIX with the frontend's rule (shared/api-prefix), or
// the dev proxy and the compiled prefix would miss its routes: nothing but slashes means `api`.
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

    it.each([undefined, '', '  ', '/', '//', ' / '])('is api for %j', async (value) => {
        expect(await loadPrefix(value)).toBe('api')
    })

    it.each([
        ['/v1/', 'v1'],
        [' //v1// ', 'v1'],
        ['internal/v2', 'internal/v2'],
    ])('keeps %j as %j', async (value, expected) => {
        expect(await loadPrefix(value)).toBe(expected)
    })
})
