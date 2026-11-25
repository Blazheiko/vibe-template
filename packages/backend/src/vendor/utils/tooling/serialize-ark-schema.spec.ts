import { type } from '@arktype/type'
import { describe, expect, it } from 'vitest'

import { EntityIdStringSchema } from 'shared/brands'

import { serializeArkSchema } from './serialize-ark-schema.js'

describe('serializeArkSchema', () => {
    // feat-262: an id narrowed to the bigint bound keeps its JSON Schema (the pattern it narrows);
    // without the predicate fallback toJsonSchema() throws and the route docs lose the whole schema.
    it('documents a narrowed field by the shape it narrows', () => {
        const serialized = serializeArkSchema(type({ id: EntityIdStringSchema }))

        expect(serialized.jsonSchema).toMatchObject({
            type: 'object',
            properties: { id: { type: 'string', pattern: '^[1-9]\\d{0,18}$' } },
            required: ['id'],
        })
    })
})
