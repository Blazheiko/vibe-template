import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'
import { RoleSchema } from '../access/role-schema.js'

export const AdminUserListItemSchema = type({
    id: 'string',
    name: 'string',
    email: 'string',
    registeredAt: 'string',
    // feat-241: the role, and whether the email is verified (a staff role needs it).
    role: RoleSchema,
    emailVerified: 'boolean',
})
export type AdminUserListItem = typeof AdminUserListItemSchema.infer

export const AdminUserListResponseSchema = type.or(
    {
        status: "'success'",
        items: AdminUserListItemSchema.array(),
        total: 'number',
        /** The id to pass as `cursor` for the next page, or null on the last one. */
        nextCursor: 'string | null',
        hasMore: 'boolean',
    },
    CanonicalErrorResponseSchema,
)
export type AdminUserListResponse = WithCanonicalError<typeof AdminUserListResponseSchema.infer>

/** PATCH /admin/users/:id/role (feat-241): the role the user has now; `changed` false for a no-op. */
export const SetUserRoleResponseSchema = type.or(
    {
        status: "'success'",
        user: { id: 'string', role: RoleSchema },
        changed: 'boolean',
    },
    CanonicalErrorResponseSchema,
)
export type SetUserRoleResponse = WithCanonicalError<typeof SetUserRoleResponseSchema.infer>

/** feat-247 (Р13): the factors an administrator's reset removed. */
export const ResetUserMfaResponseSchema = type.or(
    {
        status: "'success'",
        user: { id: 'string' },
        removed: { totp: 'boolean', passkeys: 'number', recoveryCodes: 'number' },
    },
    CanonicalErrorResponseSchema,
)
export type ResetUserMfaResponse = WithCanonicalError<typeof ResetUserMfaResponseSchema.infer>
