import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Static caching (code-issues items 39, 40, 41): Cache-Control by path, RFC 9110
// If-None-Match, a memory budget with streaming from disk, br/gzip variants.
vi.mock('#config/app.js', () => ({
    default: {
        env: 'manual-test',
        serveStatic: true,
        staticMaxMemoryFileSize: 64 * 1024,
        staticMaxMemoryTotal: 200 * 1024,
    },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { cacheFile, staticCacheHandler } = await import('./static-server.js')
type Entry = Parameters<typeof staticCacheHandler>[2]

const ROOT = path.join(process.cwd(), './public-test')
const DIR = path.join(ROOT, 'caching-fixture')
const JS = 'console.log("hello static cache");\n'.repeat(200) // ~7 KiB, compressible
const BIG = Buffer.alloc(300 * 1024, 7) // over the 64 KiB per-file limit
const files: Record<string, string | Buffer> = {
    'assets/app-abc123.js': JS,
    'manifest.json': JSON.stringify({ name: 'x'.repeat(2000) }),
    'service-worker.js': JS,
    'tiny.txt': 'tiny',
    'big.mp4': BIG,
    // 4 × 60 KiB: each fits the per-file limit, together they pass the 200 KiB budget.
    'chunk-1.wav': Buffer.alloc(60 * 1024, 1),
    'chunk-2.wav': Buffer.alloc(60 * 1024, 2),
    'chunk-3.wav': Buffer.alloc(60 * 1024, 3),
    'chunk-4.wav': Buffer.alloc(60 * 1024, 4),
}

interface Captured {
    status: string
    headers: Record<string, string>
    body: Buffer
    /** feat-112: true when the answer ended with endWithoutBody (no Content-Length). */
    withoutBody?: boolean
}

// A uWS response double; tryEnd accepts at most `window` bytes per call to force backpressure.
const createRes = (window = Number.POSITIVE_INFINITY) => {
    const captured: Captured = { status: '', headers: {}, body: Buffer.alloc(0) }
    let offset = 0
    let writable: ((offset: number) => boolean) | undefined
    let finished: () => void = () => {}
    const done = new Promise<void>((resolve) => (finished = resolve))
    const res = {
        cork: (cb: () => void) => {
            cb()
            return res
        },
        writeStatus: (status: string) => {
            captured.status = status
            return res
        },
        writeHeader: (name: string, value: string) => {
            captured.headers[name.toLowerCase()] = value
            return res
        },
        end: (body?: string | Buffer) => {
            if (body !== undefined) captured.body = Buffer.from(body)
            finished()
            return res
        },
        endWithoutBody: () => {
            captured.withoutBody = true
            finished()
            return res
        },
        onAborted: () => res,
        close: () => {
            finished()
            return res
        },
        getWriteOffset: () => offset,
        onWritable: (cb: (offset: number) => boolean) => {
            writable = cb
            // uWS calls the handler each time the socket drains, until it returns true.
            const drain = (): void => {
                if (writable?.(offset) === false) setTimeout(drain, 0)
            }
            setTimeout(drain, 0)
            return res
        },
        tryEnd: (chunk: ArrayBuffer, total: number): [boolean, boolean] => {
            const accepted = Math.min(chunk.byteLength, window)
            captured.body = Buffer.concat([captured.body, Buffer.from(chunk.slice(0, accepted))])
            offset += accepted
            const isDone = offset >= total
            if (isDone) finished()
            return [accepted === chunk.byteLength, isDone]
        },
    }
    return { res, captured, done }
}

const request = async (
    url: string,
    entry: Entry,
    headers: Record<string, string> = {},
    window?: number,
): Promise<Captured> => {
    const { res, captured, done } = createRes(window)
    const req = { getUrl: () => url, getHeader: (name: string) => headers[name] ?? '' }
    await staticCacheHandler(res as never, req as never, entry)
    await done
    return captured
}

const entries = new Map<string, Entry>()

beforeAll(async () => {
    const { cacheStaticSource } = await import('./static-server.js')
    for (const [name, data] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(DIR, name)), { recursive: true })
        await fs.writeFile(path.join(DIR, name), data)
    }
    for (const name of Object.keys(files)) await cacheFile(path.join(DIR, name))
    const cache = (await cacheStaticSource()) ?? new Map()
    for (const name of Object.keys(files)) {
        const entry = cache.get(`/caching-fixture/${name}`)
        if (entry !== undefined) entries.set(name, entry)
    }
})

afterAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true })
})

const at = (name: string): Entry => {
    const entry = entries.get(name)
    if (entry === undefined) throw new Error(`no entry for ${name}`)
    return entry
}

describe('Cache-Control by path (item 39)', () => {
    it('keeps content-hashed /assets/* for a year', async () => {
        const response = await request('/assets/app-abc123.js', at('assets/app-abc123.js'))
        expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    })

    it.each([
        ['/manifest.json', 'manifest.json'],
        ['/service-worker.js', 'service-worker.js'],
    ])('revalidates %s on every use', async (url, name) => {
        const response = await request(url, at(name))
        expect(response.headers['cache-control']).toBe('no-cache')
    })
})

describe('If-None-Match (item 40)', () => {
    it.each([
        ['the exact tag', (etag: string) => etag],
        ['a list with the tag', (etag: string) => `"other", ${etag}`],
        ['a weak copy', (etag: string) => `W/${etag}`],
        ['the wildcard', () => '*'],
    ])('answers 304 for %s', async (_name, header) => {
        const entry = at('manifest.json')
        const response = await request('/manifest.json', entry, {
            'if-none-match': header(entry.etag),
        })
        expect(response.status).toBe('304 Not Modified')
        expect(response.body.length).toBe(0)
        // feat-112: res.end() would add Content-Length: 0 to the 304.
        expect(response.withoutBody).toBe(true)
    })

    it('answers 200 for another tag', async () => {
        const response = await request('/manifest.json', at('manifest.json'), {
            'if-none-match': '"other"',
        })
        expect(response.status).toBe('200 OK')
    })
})

describe('memory budget and streaming (item 41)', () => {
    it('keeps a file over the per-file limit on disk and streams it byte for byte', async () => {
        const entry = at('big.mp4')
        expect(entry.kind).toBe('disk')

        const response = await request('/big.mp4', entry, {}, 16 * 1024)

        expect(response.status).toBe('200 OK')
        expect(response.body.equals(BIG)).toBe(true)
        expect(response.headers['etag']).toMatch(/^W\/"/)
    })

    it('closes the response when the file on disk got shorter than at startup', async () => {
        const entry = at('big.mp4')
        if (entry.kind !== 'disk') throw new Error('expected a disk entry')
        // Same file, but Content-Length from a larger version seen at startup.
        const stale = { ...entry, size: BIG.length + 4096 }

        const response = await request('/big.mp4', stale, {}, 16 * 1024)

        expect(response.body.length).toBe(BIG.length)
    })

    it('streams the files that no longer fit the total budget', () => {
        const kinds = ['chunk-1.wav', 'chunk-2.wav', 'chunk-3.wav', 'chunk-4.wav'].map(
            (name) => at(name).kind,
        )
        expect(kinds.filter((kind) => kind === 'memory').length).toBeGreaterThan(0)
        expect(kinds.at(-1)).toBe('disk')
    })

    it('keeps small files in memory', () => {
        expect(at('assets/app-abc123.js').kind).toBe('memory')
        expect(at('tiny.txt').kind).toBe('memory')
    })
})

describe('br / gzip (item 41)', () => {
    const url = '/assets/app-abc123.js'

    it('serves br to a client that accepts it', async () => {
        const response = await request(url, at('assets/app-abc123.js'), {
            'accept-encoding': 'gzip, deflate, br',
        })
        expect(response.headers['content-encoding']).toBe('br')
        expect(response.headers['vary']).toBe('Accept-Encoding')
        expect(brotliDecompressSync(response.body).toString()).toBe(JS)
    })

    it('sends Vary: Accept-Encoding on a 304 too', async () => {
        const entry = at('assets/app-abc123.js')
        const response = await request(url, entry, { 'if-none-match': entry.etag })
        expect(response.status).toBe('304 Not Modified')
        expect(response.headers['vary']).toBe('Accept-Encoding')
    })

    it('serves gzip when br is not accepted', async () => {
        const response = await request(url, at('assets/app-abc123.js'), {
            'accept-encoding': 'gzip',
        })
        expect(response.headers['content-encoding']).toBe('gzip')
        expect(gunzipSync(response.body).toString()).toBe(JS)
    })

    it('serves the original without Accept-Encoding, still with Vary', async () => {
        const response = await request(url, at('assets/app-abc123.js'))
        expect(response.headers['content-encoding']).toBeUndefined()
        expect(response.headers['vary']).toBe('Accept-Encoding')
        expect(response.body.toString()).toBe(JS)
    })

    it('respects q=0', async () => {
        const response = await request(url, at('assets/app-abc123.js'), {
            'accept-encoding': 'br;q=0, gzip',
        })
        expect(response.headers['content-encoding']).toBe('gzip')
    })

    it('does not compress tiny files', async () => {
        const response = await request('/tiny.txt', at('tiny.txt'), { 'accept-encoding': 'br' })
        expect(response.headers['content-encoding']).toBeUndefined()
        expect(response.headers['vary']).toBeUndefined()
    })
})
