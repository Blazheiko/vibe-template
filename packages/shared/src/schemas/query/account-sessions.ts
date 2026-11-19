import { type } from '@arktype/type'
import type { QueryInputOf } from './types.js'

// feat-233 (Р7): the opaque position of the last session a page looked at. Its form is checked by
// the backend; here only that it is a short base64url string.
export const ListSessionsQuerySchema = type({
    'cursor?': /^[\w-]{1,128}$/,
})

export type ListSessionsQuery = typeof ListSessionsQuerySchema.infer
export type ListSessionsQueryInput = QueryInputOf<typeof ListSessionsQuerySchema>
