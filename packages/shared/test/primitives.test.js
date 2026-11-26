import test from 'node:test'
import assert from 'node:assert/strict'
import { type } from '@arktype/type'
import {
    NonEmptyStringSchema,
    NonNegativeIntSchema,
    PositiveIntSchema,
} from '../dist/brands/index.js'
import * as brands from '../dist/brands/index.js'

// feat-268 (plan Р9): the primitive brands kept as building blocks of the template.
const accepts = (schema, value) => !(schema(value) instanceof type.errors)

test('PositiveInt accepts whole numbers above zero', () => {
    for (const value of [1, 2, 1_000_000]) assert.equal(accepts(PositiveIntSchema, value), true)
    for (const value of [0, -1, 1.5, Number.NaN, '1', null]) {
        assert.equal(accepts(PositiveIntSchema, value), false, String(value))
    }
})

test('NonNegativeInt accepts zero and whole numbers above it', () => {
    for (const value of [0, 1, 42]) assert.equal(accepts(NonNegativeIntSchema, value), true)
    for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, '0', undefined]) {
        assert.equal(accepts(NonNegativeIntSchema, value), false, String(value))
    }
})

test('NonEmptyString accepts a string of at least one character', () => {
    for (const value of ['a', ' ', 'text']) assert.equal(accepts(NonEmptyStringSchema, value), true)
    for (const value of ['', 0, null, []]) {
        assert.equal(accepts(NonEmptyStringSchema, value), false, JSON.stringify(value))
    }
})

test('PriceInCents is gone (Р9)', () => {
    assert.equal('PriceInCentsSchema' in brands, false)
})

// feat-268 (plan Р8): the wire brands of the responses.
test('IsoDateTime accepts the text of toISOString and refuses other text', () => {
    const { IsoDateTimeSchema } = brands
    assert.equal(accepts(IsoDateTimeSchema, new Date(0).toISOString()), true)
    for (const value of ['', 'yesterday', '2026-13-01T00:00:00.000Z', 1]) {
        assert.equal(accepts(IsoDateTimeSchema, value), false, String(value))
    }
})

test('SessionPublicId is 22 base64url characters', () => {
    const { SessionPublicIdSchema } = brands
    assert.equal(accepts(SessionPublicIdSchema, 'abcdefghij_-KLMNOPQRST'), true)
    for (const value of ['short', 'abcdefghij_-KLMNOPQRST1', 'abcdefghij+/KLMNOPQRST']) {
        assert.equal(accepts(SessionPublicIdSchema, value), false, value)
    }
})
