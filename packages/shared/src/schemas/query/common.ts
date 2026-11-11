import { type } from '@arktype/type'
import type { DateString, PositiveIntInput } from './types.js'

const positiveIntFromString = type('string.integer.parse').pipe(type('number > 0'))

/**
 * The largest page a list answers with; the services clamp to it as well. The bound in the
 * schema below is the same number, written out because the schema is a string literal
 * (test/contracts.test.js checks that the two agree).
 */
export const MAX_PAGE_LIMIT = 200

const limitIntFromString = type('string.integer.parse').pipe(type('0 < number <= 200'))

const dateFromString = type('string.date.parse')

export const PositiveIntFromString = positiveIntFromString
export const LimitIntFromString = limitIntFromString
export const DateFromString = dateFromString

export const PaginationFields = {
    page: positiveIntFromString.default('1'),
    limit: limitIntFromString.default('50'),
} as const

export const DateRangeFields = {
    'dateFrom?': dateFromString,
    'dateTo?': dateFromString,
} as const

export interface PaginationQueryInput {
    page?: PositiveIntInput
    limit?: PositiveIntInput
}

export interface DateRangeQueryInput {
    dateFrom?: DateString
    dateTo?: DateString
}
