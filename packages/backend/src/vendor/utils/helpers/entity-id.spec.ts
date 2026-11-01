import { describe, expect, it } from 'vitest'
import { isCanonicalEntityId } from './entity-id.js'

describe('entity-id helpers', () => {
    it('accepts only canonical positive entity IDs', () => {
        expect(isCanonicalEntityId('1')).toBe(true)
        expect(isCanonicalEntityId('10')).toBe(true)
        expect(isCanonicalEntityId('0')).toBe(false)
        expect(isCanonicalEntityId('00123')).toBe(false)
    })
})
