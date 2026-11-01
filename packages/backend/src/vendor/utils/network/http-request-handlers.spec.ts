import { describe, expect, it, vi } from 'vitest'

import { detectBodyKind, resolveMaxBodySize } from './http-request-handlers.js'

// Distinct values so each assertion shows which config field was picked.
vi.mock('#config/app.js', () => ({
    default: {
        maxBodySize: 1,
        maxJsonBodySize: 2,
        maxMultipartBodySize: 3,
        maxOctetStreamBodySize: 4,
    },
}))
vi.mock('uWebSockets.js', () => ({ getParts: vi.fn() }))

describe('detectBodyKind', () => {
    it.each([
        ['application/json', 'json'],
        ['application/json; charset=utf-8', 'json'],
        ['APPLICATION/JSON', 'json'],
        ['application/json-patch+json', 'other'],
        ['multipart/form-data; boundary=x', 'multipart'],
        ['application/x-www-form-urlencoded', 'urlencoded'],
        ['text/plain', 'text'],
        ['application/octet-stream', 'octet'],
        ['', 'other'],
    ])('%j → %s', (contentType, kind) => {
        expect(detectBodyKind(contentType)).toBe(kind)
    })
})

describe('resolveMaxBodySize', () => {
    it.each([
        ['json', 2],
        ['multipart', 3],
        ['octet', 4],
        ['urlencoded', 1],
        ['text', 1],
        ['other', 1],
    ] as const)('%s → %i', (kind, limit) => {
        expect(resolveMaxBodySize(kind)).toBe(limit)
    })
})

describe('resolveMaxBodySize with a route limit', () => {
    it('lets a route tighten the limit of its kind', () => {
        expect(resolveMaxBodySize('multipart', 2)).toBe(2)
        expect(resolveMaxBodySize('json', 1)).toBe(1)
    })

    it('never loosens it: the smaller of the two wins', () => {
        expect(resolveMaxBodySize('multipart', 100)).toBe(3)
        expect(resolveMaxBodySize('octet', 4)).toBe(4)
    })

    it('is the limit of the kind without a route limit', () => {
        expect(resolveMaxBodySize('multipart', undefined)).toBe(3)
    })
})
