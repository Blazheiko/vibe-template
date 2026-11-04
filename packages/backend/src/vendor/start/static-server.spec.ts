import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('#config/app.js', () => ({
    default: {
        env: 'manual-test',
        serveStatic: true,
        staticMaxMemoryFileSize: 1_048_576,
        staticMaxMemoryTotal: 67_108_864,
    },
}))

const { cacheFile, memoryEntry, staticCacheHandler } = await import('./static-server.js')

const STATIC_PATH = path.join(process.cwd(), './public-test')
const HTML_NAME = 'static-server-etag-fixture.html'
const HTML_PATH = path.join(STATIC_PATH, HTML_NAME)
const HTML_URL = `/${HTML_NAME}`

/**
 * Two shells of identical byte length that differ only in the asset hash — the
 * shape every rebuild of a hashed-asset SPA bundle produces.
 */
const SHELL_A = '<html><body><script src="/assets/index-aaaa1111.js"></script></body></html>'
const SHELL_B = '<html><body><script src="/assets/index-bbbb2222.js"></script></body></html>'

interface CapturedResponse {
    status: string
    // Every writeHeader call in order, so a duplicated header is not silently overwritten.
    headers: { name: string; value: string }[]
    body: string | undefined
    withoutBody?: boolean
}

const createRes = (captured: CapturedResponse) => ({
    cork: (callback: () => void): void => {
        callback()
    },
    writeStatus: (status: string): void => {
        captured.status = status
    },
    writeHeader: (name: string, value: string): void => {
        captured.headers.push({ name, value })
    },
    end: (body?: string | Buffer): void => {
        captured.body = body === undefined ? undefined : body.toString()
    },
    endWithoutBody: (): void => {
        captured.withoutBody = true
    },
})

const header = (response: CapturedResponse, name: string): string | undefined => {
    const matches = response.headers.filter((item) => item.name.toLowerCase() === name)
    expect(matches.length).toBeLessThanOrEqual(1)
    return matches[0]?.value
}

const requestHtml = async (data: string, ifNoneMatch: string): Promise<CapturedResponse> => {
    const captured: CapturedResponse = {
        status: '',
        headers: [],
        body: undefined,
    }
    const req = {
        getUrl: () => HTML_URL,
        getHeader: (name: string) => (name === 'if-none-match' ? ifNoneMatch : ''),
    }

    await staticCacheHandler(createRes(captured) as never, req as never, memoryEntry(data, 'html'))

    return captured
}

describe('staticCacheHandler HTML validators', () => {
    beforeAll(async () => {
        await fs.mkdir(STATIC_PATH, { recursive: true })
    })

    afterAll(async () => {
        await fs.rm(HTML_PATH, { force: true })
    })

    it('serves the shell with a revalidating cache policy', async () => {
        await fs.writeFile(HTML_PATH, SHELL_A, 'utf8')
        await cacheFile(HTML_PATH)

        const response = await requestHtml(SHELL_A, '')

        expect(response.status).toBe('200 OK')
        expect(response.body).toBe(SHELL_A)
        expect(header(response, 'cache-control')).toBe('public, max-age=0, must-revalidate')
        expect(header(response, 'etag')).toBeDefined()
    })

    it('answers 304 when the client already has this exact shell', async () => {
        await fs.writeFile(HTML_PATH, SHELL_A, 'utf8')
        await cacheFile(HTML_PATH)
        const first = await requestHtml(SHELL_A, '')

        const response = await requestHtml(SHELL_A, header(first, 'etag') ?? '')

        expect(response.status).toBe('304 Not Modified')
        expect(response.body).toBeUndefined()
        // feat-112: without the Content-Length: 0 that res.end() writes.
        expect(response.withoutBody).toBe(true)
    })

    it('does not validate a redeployed shell of identical byte length', async () => {
        await fs.writeFile(HTML_PATH, SHELL_A, 'utf8')
        await cacheFile(HTML_PATH)
        const staleEtag = header(await requestHtml(SHELL_A, ''), 'etag') ?? ''

        // Redeploy: same length, different asset hash.
        expect(SHELL_B.length).toBe(SHELL_A.length)
        await fs.writeFile(HTML_PATH, SHELL_B, 'utf8')
        await cacheFile(HTML_PATH)

        const response = await requestHtml(SHELL_B, staleEtag)

        expect(response.status).toBe('200 OK')
        expect(response.body).toBe(SHELL_B)
        expect(header(response, 'etag')).not.toBe(staleEtag)
    })
})
