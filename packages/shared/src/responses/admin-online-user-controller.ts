import { type } from '@arktype/type'
import { RoleSchema } from '../access/index.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

export const AdminOnlineUserListItemSchema = type({
    id: 'string',
    name: 'string',
    email: 'string',
    appType: "'web' | 'pwa'",
    userAgent: 'string',
    connectionsCount: 'number',
})
export type AdminOnlineUserListItem = typeof AdminOnlineUserListItemSchema.infer

export const AdminOnlineUserConnectionSchema = type({
    uuid: 'string',
    ip: 'string',
    userAgent: 'string',
    appType: "'web' | 'pwa'",
})
export type AdminOnlineUserConnection = typeof AdminOnlineUserConnectionSchema.infer

export const AdminOnlineUserDetailSchema = type({
    id: 'string',
    name: 'string',
    email: 'string',
    phone: 'string | null',
    role: RoleSchema,
    createdAt: 'string',
    isOnline: 'boolean',
    appType: "'web' | 'pwa' | null",
    userAgent: 'string | null',
    connections: AdminOnlineUserConnectionSchema.array(),
})
export type AdminOnlineUserDetail = typeof AdminOnlineUserDetailSchema.infer

export const AdminOnlineUserListResponseSchema = type.or(
    { status: "'success'", items: AdminOnlineUserListItemSchema.array(), total: 'number' },
    CanonicalErrorResponseSchema,
)
export type AdminOnlineUserListResponse = WithCanonicalError<
    typeof AdminOnlineUserListResponseSchema.infer
>

export const AdminOnlineUserDetailResponseSchema = type.or(
    { status: "'success'", user: AdminOnlineUserDetailSchema },
    CanonicalErrorResponseSchema,
)
export type AdminOnlineUserDetailResponse = WithCanonicalError<
    typeof AdminOnlineUserDetailResponseSchema.infer
>

export const AdminOnlineUsersWsResponseSchema = type.or(
    { status: "'success'" },
    CanonicalErrorResponseSchema,
)
export type AdminOnlineUsersWsResponse = WithCanonicalError<
    typeof AdminOnlineUsersWsResponseSchema.infer
>
