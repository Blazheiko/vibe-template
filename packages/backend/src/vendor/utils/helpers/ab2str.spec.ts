import { describe, expect, it } from 'vitest'
import { ab2str } from './ab2str.js'

describe('ab2str', () => {
    const buffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer

    it('reads UTF-8 by default', () => {
        expect(ab2str(buffer('{"a":"привіт"}'))).toBe('{"a":"привіт"}')
    })

    it('reads another encoding when asked', () => {
        expect(ab2str(buffer('hi'), 'hex')).toBe('6869')
    })

    it('reads an empty buffer as an empty string', () => {
        expect(ab2str(new ArrayBuffer(0))).toBe('')
    })
})
