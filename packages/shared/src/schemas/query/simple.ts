import { type } from '@arktype/type'
import type { QueryInputOf } from './types.js'

export const AdminUserSearchQuerySchema = type({
    email: 'string > 0',
})

export type AdminUserSearchQuery = typeof AdminUserSearchQuerySchema.infer
export type AdminUserSearchQueryInput = QueryInputOf<typeof AdminUserSearchQuerySchema>

export const OAuthRedirectQuerySchema = type({})

export type OAuthRedirectQuery = typeof OAuthRedirectQuerySchema.infer
export type OAuthRedirectQueryInput = QueryInputOf<typeof OAuthRedirectQuerySchema>

export const OAuthCallbackQuerySchema = type({
    'code?': 'string',
    'state?': 'string',
})

export type OAuthCallbackQuery = typeof OAuthCallbackQuerySchema.infer
export type OAuthCallbackQueryInput = QueryInputOf<typeof OAuthCallbackQuerySchema>
