import { type } from '@arktype/type'
import { RoleSchema } from '../../access/role-schema.js'

/**
 * PATCH /admin/users/:id/role (feat-241, docs/plan/roles-permissions-plan.md Р6): the new role of
 * the user. Who may give which role, and to whom, is the server's (the delegation policy, a
 * verified email for a staff role, the last admin).
 */
export const SetUserRoleInputSchema = type({
    role: RoleSchema,
    '+': 'reject',
})
export type SetUserRoleInput = typeof SetUserRoleInputSchema.infer
