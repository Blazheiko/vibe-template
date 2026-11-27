import { describe, expect, it, vi } from 'vitest'

// No mock of uWebSockets.js: the real getParts splits the body (feat-275).
vi.mock('#vendor/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { parseMultipart } from './http-request-handlers.js'

const BOUNDARY = '----feat275boundary'

const textPart = (name: string, value: string): string =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`

const body = Buffer.concat([
    Buffer.from(textPart('a', 'Привіт, світ') + textPart('b', 'emoji 👋 ünï'), 'utf8'),
    Buffer.from(
        `--${BOUNDARY}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="a.bin"\r\n' +
            'Content-Type: application/octet-stream\r\n\r\n',
    ),
    Buffer.from([0x00, 0xff, 0x10]),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
])

describe('parseMultipart', () => {
    it('decodes text fields as UTF-8 and keeps the file out of the payload', () => {
        const { payload, files } = parseMultipart(body, `multipart/form-data; boundary=${BOUNDARY}`)

        expect({ ...payload }).toEqual({ a: 'Привіт, світ', b: 'emoji 👋 ünï' })
        expect([...files.keys()]).toEqual(['file'])
        const file = files.get('file')
        expect(file?.filename).toBe('a.bin')
        expect(file?.type).toBe('application/octet-stream')
        expect(Buffer.from(file?.data ?? new ArrayBuffer(0))).toEqual(
            Buffer.from([0x00, 0xff, 0x10]),
        )
    })
})
