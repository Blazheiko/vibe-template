// feat-240 (docs/plan/roles-permissions-plan.md, Р1, Р2): the closed catalog of roles and
// permissions. A user has one role, stored by name in users.role; what it may do is computed
// from this catalog, never read from the database. The backend checks a permission per route
// (`can:<permission>`, `ws_can:<permission>`); the frontend uses the same catalog only to hide
// what a role cannot use. No ArkType here: the frontend bundle imports this module at runtime
// (the role schema is in role-schema.ts).

/** Every role, in the order of the `user_role` enum. */
export const ROLES = ['user', 'support_operator', 'kb_editor', 'user_admin', 'admin'] as const
export type Role = (typeof ROLES)[number]

/** Every permission; each one guards a group of routes (Р2). */
export const PERMISSIONS = [
    'kb.read',
    'kb.write',
    'kb.manage',
    'prompts.manage',
    'ai_usage.read',
    'users.read',
    'users.sensitive.read',
    'users.roles.assign',
    // feat-247 (Р13): reset the second factors of another account; the admin's alone.
    'users.mfa.reset',
    'audit.read.account',
    'audit.read',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export interface RoleDefinition {
    readonly permissions: readonly Permission[]
    /**
     * The delegation policy (Р2): the roles a holder of this role may both take away and give.
     * Explicit, not derived from the permissions: a `user_admin` manages who edits the knowledge
     * base without being able to edit it.
     */
    readonly assignableRoles: readonly Role[]
}

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
    user: { permissions: [], assignableRoles: [] },
    support_operator: {
        permissions: ['users.read', 'audit.read.account', 'kb.read'],
        assignableRoles: [],
    },
    kb_editor: { permissions: ['kb.read', 'kb.write'], assignableRoles: [] },
    user_admin: {
        permissions: ['users.read', 'users.roles.assign', 'audit.read', 'audit.read.account'],
        assignableRoles: ['user', 'support_operator', 'kb_editor'],
    },
    // Every permission, so a new one is the admin's and nobody else's.
    admin: { permissions: PERMISSIONS, assignableRoles: ROLES },
}

export function isRole(value: unknown): value is Role {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function roleHasPermission(role: Role | null | undefined, permission: Permission): boolean {
    if (role === null || role === undefined) return false
    return ROLE_DEFINITIONS[role].permissions.includes(permission)
}

/** A role with at least one permission: it may enter the admin area. */
export function isStaffRole(role: Role | null | undefined): boolean {
    if (role === null || role === undefined) return false
    return ROLE_DEFINITIONS[role].permissions.length > 0
}

export const STAFF_ROLES: readonly Role[] = ROLES.filter((role) => isStaffRole(role))

/**
 * Whether a holder of `actorRole` may change a role from `fromRole` to `toRole` by the
 * delegation policy (Р6, rule 2). Both roles of the target must be in the actor's
 * `assignableRoles`. Other rules (own role, verified identity, last admin) are the service's.
 */
export function canAssignRole(actorRole: Role, fromRole: Role, toRole: Role): boolean {
    const { assignableRoles } = ROLE_DEFINITIONS[actorRole]
    return assignableRoles.includes(fromRole) && assignableRoles.includes(toRole)
}
