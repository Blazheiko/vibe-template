import { type } from '@arktype/type'
import type { DateString, PositiveIntInput } from './types.js'

const positiveIntFromString = type('string.integer.parse').pipe(type('number > 0'))

const limitIntFromString = type('string.integer.parse').pipe(type('0 < number <= 200'))

const dateFromString = type('string.date.parse')

export const PositiveIntFromString = positiveIntFromString
export const LimitIntFromString = limitIntFromString
export const DateFromString = dateFromString

// ArkType 2.2.0 still requires a tuple-default cast workaround here.
// It is intentionally kept as an internal implementation detail, but it is
// not considered solved: some parse/default query outputs still depend on
// cast-driven compatibility types to keep emitted typings usable.
export const PaginationFields = {
    page: [positiveIntFromString, '=', '1'] as unknown as 'string.integer.parse',
    limit: [limitIntFromString, '=', '50'] as unknown as 'string.integer.parse',
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
