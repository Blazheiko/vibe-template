import { describe, expect, it } from 'vitest'
import { normalizePath } from './normalize-path.js'

describe('normalizePath', () => {
    it.each([
        ['', ''],
        ['/', ''],
        ['api', 'api'],
        ['/api', 'api'],
        ['api/', 'api'],
        ['/api/', 'api'],
        ['/api/v1/', 'api/v1'],
        // one slash from each end, no more
        ['//api//', '/api/'],
        ['///', '/'],
    ])('%j -> %j', (input, expected) => {
        expect(normalizePath(input)).toBe(expected)
    })
})
