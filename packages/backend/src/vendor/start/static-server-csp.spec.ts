import { statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    CSP_HEADER,
    CSP_REPORT_ONLY_HEADER,
    STRICT_CSP,
    SVG_CSP,
} from '#vendor/utils/network/csp.js'

vi.mock('#config/app.js', () => ({
    default: {
        env: 'manual-test',
        serveStatic: true,
        staticMaxMemoryFileSize: 1_048_576,
        staticMaxMemoryTotal: 67_108_864,
    },
}))

const DOCUMENT_POLICY = "default-src 'self'; script-src 'self'"
const INDEX_PATH = path.join(process.cwd(), './public-test/index.html')

type Mode = 'disabled' | 'enforcing' | 'report-only'

interface CapturedResponse {
    status: string
    // Every writeHeader call, so duplicates are visible (a map would hide them).
    headers: { name: string; value: string }[]
}

const cspHeaders = (response: CapturedResponse) =>
    response.headers.filter((header) => {
        const name = header.name.toLowerCase()
        return name === CSP_HEADER || name === CSP_REPORT_ONLY_HEADER
    })

const headerValue = (response: CapturedResponse, name: string): string | undefined =>
    response.headers.find((header) => header.name.toLowerCase() === name)?.value

const loadStaticServer = async (mode: Mode) => {
    vi.resetModules()
    vi.doMock('#config/csp.js', () => ({
        default: {
            enabled: mode !== 'disabled',
            reportOnly: mode === 'report-only',
            documentPolicy: DOCUMENT_POLICY,
            configError: null,
        },
    }))
    const staticServer = await import('./static-server.js')
    await staticServer.cacheFile(INDEX_PATH)
    return staticServer
}

const createReq = (url: string, ifNoneMatch = '') => ({
    getUrl: () => url,
    getHeader: (name: string) => (name === 'if-none-match' ? ifNoneMatch : ''),
})

const createRes = () => {
    const captured: CapturedResponse = { status: '', headers: [] }
    const res = {
        cork: (callback: () => void): void => {
            callback()
        },
        writeStatus: (status: string): void => {
            captured.status = status
        },
        writeHeader: (name: string, value: string): void => {
            captured.headers.push({ name, value })
        },
        end: (): void => {},
        endWithoutBody: (): void => {},
        // What a file streamed from disk needs: the first chunk ends the response.
        onAborted: (): void => {},
        getWriteOffset: (): number => 0,
        tryEnd: (): [boolean, boolean] => [true, true],
        close: (): void => {},
    }
    return { res, captured }
}

type StaticServer = Awaited<ReturnType<typeof loadStaticServer>>

const viaCache = async (
    server: StaticServer,
    url: string,
    data: string,
    ifNoneMatch = '',
): Promise<CapturedResponse> => {
    const { res, captured } = createRes()
    await server.staticCacheHandler(
        res as never,
        createReq(url, ifNoneMatch) as never,
        server.memoryEntry(data),
    )
    return captured
}

const viaFallback = async (server: StaticServer, url: string): Promise<CapturedResponse> => {
    const { res, captured } = createRes()
    await server.staticHandler(res as never, createReq(url) as never)
    return captured
}

// feat-206 (L-15): a file over STATIC_MAX_MEMORY_FILE_SIZE, or cached after the memory budget
// ran out, is a `disk` entry. The file on disk here is the index; the URL decides the type.
const viaDisk = async (
    server: StaticServer,
    url: string,
    ifNoneMatch = '',
): Promise<CapturedResponse> => {
    const { res, captured } = createRes()
    await server.staticCacheHandler(res as never, createReq(url, ifNoneMatch) as never, {
        kind: 'disk',
        filePath: INDEX_PATH,
        size: statSync(INDEX_PATH).size,
        etag: '"disk-etag"',
    })
    return captured
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'

/** Each case returns the response and the policy kind it must carry when CSP is on. */
const CASES: [
    string,
    (server: StaticServer) => Promise<CapturedResponse>,
    'document' | 'svg' | 'strict' | null,
][] = [
    ['/ 200', (s) => viaCache(s, '/', '<html></html>'), 'document'],
    ['/index.html 200', (s) => viaCache(s, '/index.html', '<html></html>'), 'document'],
    [
        'HTML 304',
        async (s) => {
            const first = await viaCache(s, '/index.html', '<html></html>')
            return viaCache(s, '/index.html', '<html></html>', headerValue(first, 'etag') ?? '')
        },
        'document',
    ],
    ['SPA fallback', (s) => viaFallback(s, '/settings/profile'), 'document'],
    ['HTML from disk 200', (s) => viaDisk(s, '/report.html'), 'document'],
    ['HTML from disk 304', (s) => viaDisk(s, '/report.html', '"disk-etag"'), 'document'],
    ['.htm from disk 200', (s) => viaDisk(s, '/legacy.htm'), 'document'],
    ['index from disk 200', (s) => viaDisk(s, '/'), 'document'],
    ['JS from disk 200', (s) => viaDisk(s, '/assets/big.js'), null],
    ['SVG 200', (s) => viaCache(s, '/favicon.svg', SVG), 'svg'],
    [
        'SVG 304',
        async (s) => {
            const first = await viaCache(s, '/favicon.svg', SVG)
            return viaCache(s, '/favicon.svg', SVG, headerValue(first, 'etag') ?? '')
        },
        'svg',
    ],
    ['/service-worker.js', (s) => viaCache(s, '/service-worker.js', 'self.x=1'), null],
    ['other JS asset', (s) => viaCache(s, '/assets/index-abc.js', 'x=1'), null],
    ['missing asset 404', (s) => viaFallback(s, '/missing.js'), 'strict'],
    ['unsafe URL 400', (s) => viaFallback(s, '/../etc/passwd'), 'strict'],
]

const POLICY_VALUE = {
    document: DOCUMENT_POLICY,
    svg: SVG_CSP,
    strict: STRICT_CSP,
} as const

describe.each<Mode>(['enforcing', 'report-only', 'disabled'])('static CSP, mode %s', (mode) => {
    let server: StaticServer

    beforeEach(async () => {
        server = await loadStaticServer(mode)
    })

    it.each(CASES)('%s', async (_label, request, kind) => {
        const response = await request(server)
        const csp = cspHeaders(response)

        if (mode === 'disabled' || kind === null) {
            expect(csp).toEqual([])
            return
        }
        // Exactly one policy, and in report-only mode never an enforcing one.
        expect(csp).toHaveLength(1)
        expect(csp[0]?.name).toBe(mode === 'report-only' ? CSP_REPORT_ONLY_HEADER : CSP_HEADER)
        expect(csp[0]?.value).toBe(POLICY_VALUE[kind])
    })

    it('keeps nosniff on every static response', async () => {
        for (const [, request] of CASES) {
            const response = await request(server)
            expect(headerValue(response, 'x-content-type-options')).toBe('nosniff')
        }
    })
})
