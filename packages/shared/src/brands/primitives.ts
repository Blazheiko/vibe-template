import { type } from '@arktype/type'

export const PositiveIntSchema = type('number.integer > 0').brand('PositiveInt')
export type PositiveInt = typeof PositiveIntSchema.infer

export const NonNegativeIntSchema = type('number.integer >= 0').brand('NonNegativeInt')
export type NonNegativeInt = typeof NonNegativeIntSchema.infer

export const PriceInCentsSchema = type('number.integer >= 0').brand('PriceInCents')
export type PriceInCents = typeof PriceInCentsSchema.infer

export const NonEmptyStringSchema = type('string >= 1').brand('NonEmptyString')
export type NonEmptyString = typeof NonEmptyStringSchema.infer
