import { ROLES, canAssignRole, isStaffRole, type Role } from 'shared/access'

// feat-241 (docs/plan/roles-permissions-plan.md Р6, Р10): what the change-role dialog offers. The
// server decides; this only keeps the dialog from offering what it would refuse.

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
    user: 'User',
    support_operator: 'Support operator',
    kb_editor: 'Knowledge base editor',
    user_admin: 'User administrator',
    admin: 'Administrator',
}

export interface RoleOption {
    role: Role
    label: string
    /** Why it cannot be chosen, or null. */
    disabledReason: string | null
}

export interface RoleTarget {
    id: string
    role: Role
    emailVerified: boolean
}

/** Whether the actor may change the role of this user at all (own role, delegation policy). */
export function canChangeRoleOf(
    actor: { id: string; role: Role | undefined },
    target: RoleTarget,
): boolean {
    const actorRole = actor.role
    if (actorRole === undefined || actor.id === target.id) return false
    return ROLES.some((role) => role !== target.role && canAssignRole(actorRole, target.role, role))
}

/** The roles the actor may give this user, the current one apart. */
export function roleOptionsFor(actorRole: Role, target: RoleTarget): RoleOption[] {
    return ROLES.filter(
        (role) => role !== target.role && canAssignRole(actorRole, target.role, role),
    ).map((role) => ({
        role,
        label: ROLE_LABELS[role],
        disabledReason:
            isStaffRole(role) && !target.emailVerified ? 'Needs a verified email' : null,
    }))
}

/** The text of a refused change, by the status and reason of the answer. */
export function roleChangeErrorText(status: number, reason: string | undefined): string {
    if (status === 409 && reason === 'last_admin') return 'The last administrator keeps the role.'
    if (status === 409 && reason === 'identity_unverified') {
        return 'A staff role needs a verified email.'
    }
    // feat-247 (Р10): no staff account without a second factor.
    if (status === 409 && reason === 'mfa_not_enrolled') {
        return 'A staff role needs two-step sign-in: the user sets it up in the account first.'
    }
    if (status === 404) return 'The user no longer exists.'
    if (status === 403) return 'You may not change this role.'
    if (status === 429) return 'Too many changes, try again in a minute.'
    return 'The role could not be changed.'
}
