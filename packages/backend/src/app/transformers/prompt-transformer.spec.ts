import { describe, expect, it } from 'vitest'

import { promptTransformer } from './prompt-transformer.js'

const row = {
    id: 5n,
    type: 'SUPPORT_SYSTEM' as const,
    topic: null,
    content: 'You are support',
    model: null,
    temperature: null,
    maxTokens: null,
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    updatedAt: new Date('2026-10-25T10:01:00.000Z'),
    revision: 3,
}

describe('promptTransformer', () => {
    it('sends the id as a string and the dates as ISO strings', () => {
        const { revision: _revision, ...rest } = row
        // The revision is the cache's version of the row, not part of the answer.
        expect(promptTransformer.serialize(row)).toEqual({
            ...rest,
            id: '5',
            createdAt: '2026-10-25T10:00:00.000Z',
            updatedAt: '2026-10-25T10:01:00.000Z',
        })
    })
})
