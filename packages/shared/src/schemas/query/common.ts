import { type } from '@arktype/type'
import type { DateString, PositiveIntInput } from './types.js'

const positiveIntFromString = type('string.integer.parse').pipe(type('number > 0'))

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
