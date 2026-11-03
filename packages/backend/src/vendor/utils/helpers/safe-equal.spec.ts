import { describe, expect, it } from 'vitest'

import { safeEqual } from './safe-equal.js'

describe('safeEqual', () => {
    it.each([
        ['equal strings', 'state-abc123', 'state-abc123', true],
        ['two empty strings', '', '', true],
        ['the same length, one byte apart', 'state-abc123', 'state-abc124', false],
        ['different lengths', 'state-abc123', 'state-abc12', false],
        ['one empty string', '', 'state', false],
        ['the same characters, different bytes (UTF-8)', 'é', 'é', false],
    ])('%s', (_, a, b, expected) => {
        expect(safeEqual(a, b)).toBe(expected)
        expect(safeEqual(b, a)).toBe(expected)
    })

    it('does not check a format: any equal strings match', () => {
        expect(safeEqual('not a token at all', 'not a token at all')).toBe(true)
    })
})
