import { type } from '@arktype/type'
import { describe, expect, it } from 'vitest'

import { EntityIdSchema, EntityIdStringSchema } from 'shared/brands'

import { serializeArkSchema } from './serialize-ark-schema.js'

describe('serializeArkSchema', () => {
    // feat-262: an id narrowed to the bigint bound keeps its JSON Schema (the pattern it narrows);
    // without the predicate fallback toJsonSchema() throws and the route docs lose the whole schema.
    it.each([
        ['EntityIdStringSchema', EntityIdStringSchema],
        ['the branded EntityIdSchema', EntityIdSchema],
    ])('documents a narrowed field (%s) by the shape it narrows', (_name, id) => {
        const serialized = serializeArkSchema(type({ id }))

        expect(serialized.jsonSchema).toMatchObject({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[1-9]\\d{0,18}$' } },
            required: ['id'],
        })
    })
})
