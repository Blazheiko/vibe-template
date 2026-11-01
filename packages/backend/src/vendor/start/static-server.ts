import process from 'node:process'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import logger from '#vendor/utils/logger.js'
import appConfig from '#config/app.js'
import type { HttpRequest, HttpResponse } from '#vendor/start/server.js'
import { MIME_TYPES } from '#vendor/constants/index.js'
import { isBinaryExtension } from '#vendor/utils/helpers/file-utils.js'
import type { CspKind } from '#vendor/utils/network/csp.js'
import {
    setSecurityHeaders,
    writeHttpStatus,
} from '#vendor/utils/network/http-response-handlers.js'
import { matchesIfNoneMatch } from '#vendor/utils/network/if-none-match.js'

const STATIC_PATH =
    appConfig.env === 'manual-test'
        ? path.join(process.cwd(), './public-test')
        : path.join(process.cwd(), './public')

const ALLOWED_STATIC_EXTENSIONS = new Set([
    'html',
    'htm',
    'css',
    'js',
    'mjs',
    'webmanifest',
    'manifest',
    'json',
    'txt',
    'xml',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'ico',
    'bmp',
    'avif',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'mp3',
    'mp4',
    'webm',
    'ogg',
    'oga',
    'wav',
])

const isUrlSafe = (url: string): boolean =>
    !url.includes('..') &&
    !url.includes('\0') &&
    !url.toLowerCase().includes('%2e%2e') &&
    !url.includes('%00')

/**
 * One static file. Small files live in memory (with br/gzip variants for text
 * types); large ones, and everything past the memory budget, are streamed from
 * disk (code-issues item 41).
 */
export type StaticEntry =
    | {
          kind: 'memory'
          data: string | Buffer
          etag: string
          br?: Buffer
          gzip?: Buffer
      }
    | { kind: 'disk'; filePath: string; size: number; etag: string }

const cache = new Map<string, StaticEntry>()
let memoryUsed = 0

/**
 * Validators must be derived from content, not from byte length: a rebuild
 * typically changes only the fixed-length asset hashes inside `index.html`, so a
 * length-based ETag would keep validating an obsolete app shell and a client
 * would hold on to a shell referencing assets the new deployment no longer has.
 * Files are read once at startup, so each hash is computed once too. Streamed
 * files are not read at startup; their ETag comes from size and mtime.
 */
const computeEtag = (data: string | Buffer): string =>
    `"${crypto.createHash('sha1').update(data).digest('base64url')}"`

const COMPRESSIBLE_EXTENSIONS = new Set([
    'html',
    'htm',
    'js',
    'mjs',
    'css',
    'svg',
    'json',
    'webmanifest',
    'manifest',
    'txt',
    'xml',
])
const MIN_COMPRESS_BYTES = 1024

const byteLength = (data: string | Buffer): number =>
    Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8')

// br/gzip computed once at startup; a variant is kept only when it is smaller.
const compressedVariants = (ext: string, data: string | Buffer): { br?: Buffer; gzip?: Buffer } => {
    const size = byteLength(data)
    if (!COMPRESSIBLE_EXTENSIONS.has(ext) || size < MIN_COMPRESS_BYTES) return {}
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const br = brotliCompressSync(input, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
    })
    const gzip = gzipSync(input, { level: 9 })
    return {
        ...(br.length < size ? { br } : {}),
        ...(gzip.length < size ? { gzip } : {}),
    }
}

const memoryCost = (entry: StaticEntry | undefined): number =>
    entry?.kind === 'memory'
        ? byteLength(entry.data) + (entry.br?.length ?? 0) + (entry.gzip?.length ?? 0)
        : 0

/** An in-memory entry for `data`, with its ETag and compressed variants. */
const memoryEntry = (data: string | Buffer, ext = ''): StaticEntry => ({
    kind: 'memory',
    data,
    etag: computeEtag(data),
    ...compressedVariants(ext, data),
})

const cacheFile = async (filePath: string): Promise<void> => {
    const ext = path.extname(filePath).substring(1).toLowerCase()
    if (!ALLOWED_STATIC_EXTENSIONS.has(ext)) return
    const key = filePath.substring(STATIC_PATH.length)
    const stats = await fs.stat(filePath)
    // Re-caching a file (rebuild in place) frees the budget of its previous version.
    memoryUsed -= memoryCost(cache.get(key))

    // The SPA shell always stays in memory: the fallback route serves it for every path.
    const fitsInMemory =
        key === '/index.html' ||
        (stats.size <= appConfig.staticMaxMemoryFileSize &&
            memoryUsed + stats.size <= appConfig.staticMaxMemoryTotal)
    if (!fitsInMemory) {
        cache.set(key, {
            kind: 'disk',
            filePath,
            size: stats.size,
            etag: `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
        })
        return
    }

    const data = await fs.readFile(filePath, isBinaryExtension(ext) ? null : 'utf8')
    const entry = memoryEntry(data, ext)
    memoryUsed += memoryCost(entry)
    cache.set(key, entry)
}

const cacheDirectory = async (directoryPath: string): Promise<void> => {
    const files = await fs.readdir(directoryPath, { withFileTypes: true })
    for (const file of files) {
        if (file.name.startsWith('.')) continue
        const filePath = path.join(directoryPath, file.name)
        if (file.isDirectory()) await cacheDirectory(filePath)
        else await cacheFile(filePath)
    }
}

const cacheStaticSource = async (): Promise<Map<string, StaticEntry> | null> => {
    if (appConfig.serveStatic) {
        const stats = await fs.stat(STATIC_PATH).catch(() => null)
        if (stats?.isDirectory() !== true) {
            logger.warn(
                { staticPath: STATIC_PATH },
                'SERVE_STATIC=true, but the static directory is missing: static files are not served',
            )
            return null
        }
        await cacheDirectory(STATIC_PATH)
        const index = cache.get('/index.html')
        if (index !== undefined) cache.set('/', index)
        const onDisk = [...cache.values()].filter((entry) => entry.kind === 'disk').length
        logger.info(
            { files: cache.size, memoryBytes: memoryUsed, streamedFromDisk: onDisk },
            'Static files cached',
        )
        return cache
    }
    return null
}

// The service worker script's own CSP would govern the worker (and its fetches), so it gets none.
const SERVICE_WORKER_PATH = '/service-worker.js'

const getAssetCspKind = (url: string, ext: string): CspKind | null => {
    if (url === SERVICE_WORKER_PATH) return null
    return ext === 'svg' ? 'svg' : null
}

/**
 * The SPA shell is served as a plain cacheable static file: no session is
 * created and nothing is injected per request. The session cookie and the
 * CSRF token are issued by the API on app initialization.
 */
const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
// Vite puts content-hashed files under /assets/: safe to keep for a year.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
// Everything else keeps its name across deployments (manifest, service worker,
// icons, audio): cacheable, but revalidated by ETag every time (code-issues item 39).
const REVALIDATE_CACHE_CONTROL = 'no-cache'

const cacheControlFor = (url: string): string =>
    url.startsWith('/assets/') ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL

type Encoding = 'br' | 'gzip'

// Picks the smallest stored variant the client accepts (q=0 means "not acceptable").
const pickEncoding = (
    acceptEncoding: string,
    entry: { br?: Buffer; gzip?: Buffer },
): Encoding | null => {
    const accepted = new Set(
        acceptEncoding
            .toLowerCase()
            .split(',')
            .map((part) => part.trim())
            .filter((part) => !/;\s*q=0(\.0+)?\s*$/.test(part))
            .map((part) => part.split(';')[0]?.trim() ?? ''),
    )
    if (entry.br !== undefined && accepted.has('br')) return 'br'
    if (entry.gzip !== undefined && accepted.has('gzip')) return 'gzip'
    return null
}

const handleHtmlRequest = (
    res: HttpResponse,
    req: HttpRequest,
    entry: Extract<StaticEntry, { kind: 'memory' }>,
): void => {
    const notModified = matchesIfNoneMatch(req.getHeader('if-none-match'), entry.etag)
    const encoding = notModified ? null : pickEncoding(req.getHeader('accept-encoding'), entry)

    res.cork(() => {
        writeHttpStatus(res, notModified ? 304 : 200)
        res.writeHeader('content-type', MIME_TYPES['html'] ?? '')
        res.writeHeader('Cache-Control', HTML_CACHE_CONTROL)
        res.writeHeader('ETag', entry.etag)
        if (entry.br !== undefined || entry.gzip !== undefined) {
            res.writeHeader('Vary', 'Accept-Encoding')
        }
        setSecurityHeaders(res, [], 'document')
        if (notModified) {
            res.end()
            return
        }
        if (encoding !== null) {
            res.writeHeader('Content-Encoding', encoding)
            res.end(entry[encoding])
            return
        }
        res.end(entry.data)
    })
}

// Streams a file with uWS backpressure: tryEnd until it does not fit, then wait
// for onWritable. Every write is corked; an aborted request stops the read.
const streamFile = (
    res: HttpResponse,
    entry: Extract<StaticEntry, { kind: 'disk' }>,
    writeHeaders: () => void,
): void => {
    const stream = createReadStream(entry.filePath)
    let aborted = false
    let finished = false
    let ended = false
    let waitingForWritable = false
    res.onAborted(() => {
        aborted = true
        stream.destroy()
    })
    // Content-Length is the size seen at startup. A file that got shorter since (public/
    // rebuilt under a running server) would leave the response open forever: close it.
    const closeTruncated = (): void => {
        logger.warn(
            { filePath: entry.filePath, expected: entry.size, sent: res.getWriteOffset() },
            'Static file is shorter than at startup: response closed',
        )
        res.cork(() => res.close())
    }
    stream.on('end', () => {
        ended = true
        // A chunk still waiting for onWritable finishes (or closes) the response there.
        if (aborted || finished || waitingForWritable) return
        closeTruncated()
    })
    res.cork(() => {
        writeHttpStatus(res, 200)
        writeHeaders()
    })
    stream.on('error', (err) => {
        logger.error({ err, filePath: entry.filePath }, 'Static file stream failed')
        if (!aborted) res.cork(() => res.close())
    })
    stream.on('data', (chunk) => {
        if (aborted) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const arrayBuffer = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer
        const startOffset = res.getWriteOffset()
        // A typed result: locals assigned inside res.cork() stay narrowed to `false`.
        let result: [boolean, boolean] = [false, false]
        res.cork(() => {
            result = res.tryEnd(arrayBuffer, entry.size)
        })
        const [ok, done] = result
        if (done) {
            finished = true
            stream.destroy()
            return
        }
        if (!ok) {
            stream.pause()
            waitingForWritable = true
            res.onWritable((offset) => {
                let retry: [boolean, boolean] = [false, false]
                res.cork(() => {
                    retry = res.tryEnd(arrayBuffer.slice(offset - startOffset), entry.size)
                })
                const [retryOk, retryDone] = retry
                if (retryDone) {
                    finished = true
                    stream.destroy()
                } else if (retryOk) {
                    waitingForWritable = false
                    if (ended) closeTruncated()
                    else stream.resume()
                }
                return retryOk
            })
        }
    })
}

// async on purpose: a synchronous throw becomes a rejection the caller's .catch handles.
/* eslint-disable @typescript-eslint/require-await */
const staticCacheHandler = async (
    res: HttpResponse,
    req: HttpRequest,
    entry: StaticEntry,
): Promise<void> => {
    const url = req.getUrl()
    const ext = url.includes('.') ? path.extname(url).substring(1).toLowerCase() : ''
    const mimeType = ext !== '' ? (MIME_TYPES[ext] ?? MIME_TYPES['default']) : MIME_TYPES['html']
    const cspKind = getAssetCspKind(url, ext)
    const cacheControl = cacheControlFor(url)

    if (entry.kind === 'memory' && mimeType === MIME_TYPES['html']) {
        handleHtmlRequest(res, req, entry)
        return
    }

    // The 304 must carry the same Vary as the 200 (RFC 9110 §15.4.5).
    const hasEncodings =
        entry.kind === 'memory' && (entry.br !== undefined || entry.gzip !== undefined)

    if (matchesIfNoneMatch(req.getHeader('if-none-match'), entry.etag)) {
        res.cork(() => {
            writeHttpStatus(res, 304)
            res.writeHeader('Cache-Control', cacheControl)
            res.writeHeader('ETag', entry.etag)
            if (hasEncodings) res.writeHeader('Vary', 'Accept-Encoding')
            setSecurityHeaders(res, [], cspKind)
            res.end()
        })
        return
    }

    const writeCommonHeaders = (): void => {
        if (mimeType !== undefined && mimeType !== '') {
            res.writeHeader('Content-Type', mimeType)
        }
        res.writeHeader('Cache-Control', cacheControl)
        res.writeHeader('ETag', entry.etag)
        setSecurityHeaders(res, [], cspKind)
    }

    if (entry.kind === 'disk') {
        streamFile(res, entry, writeCommonHeaders)
        return
    }

    const encoding = pickEncoding(req.getHeader('accept-encoding'), entry)
    res.cork(() => {
        writeHttpStatus(res, 200)
        writeCommonHeaders()
        if (hasEncodings) res.writeHeader('Vary', 'Accept-Encoding')
        if (encoding !== null) {
            res.writeHeader('Content-Encoding', encoding)
            res.end(entry[encoding])
            return
        }
        res.end(entry.data)
    })
}
/* eslint-enable @typescript-eslint/require-await */

// async on purpose: a synchronous throw becomes a rejection the caller's .catch handles.
/* eslint-disable @typescript-eslint/require-await */
const staticHandler = async (res: HttpResponse, req: HttpRequest): Promise<void> => {
    const url = req.getUrl()

    if (!isUrlSafe(url)) {
        res.cork(() => {
            writeHttpStatus(res, 400)
            setSecurityHeaders(res)
            res.end('Bad Request')
        })
        return
    }

    if (!url.includes('.')) {
        const index = cache.get('/index.html')
        if (index?.kind === 'memory' && index.data !== '') {
            handleHtmlRequest(res, req, index)
            return
        }
    }

    res.cork(() => {
        writeHttpStatus(res, 404)
        res.writeHeader('Content-Type', '')
        setSecurityHeaders(res)
        res.end('')
    })
}
/* eslint-enable @typescript-eslint/require-await */

export {
    memoryEntry,
    cacheFile,
    cacheDirectory,
    cacheStaticSource,
    staticHandler,
    staticCacheHandler,
}
