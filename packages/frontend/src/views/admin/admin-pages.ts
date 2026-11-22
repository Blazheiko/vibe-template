import { isStaffRole, roleHasPermission, type Permission, type Role } from 'shared/access'

import { staffMfaTarget, type StaffMfaReason } from '@/utils/staff-mfa'

// feat-240 (Р10): the pages of the admin area and the permission each one needs; the router and
// the menu read this one list. Hiding is a convenience: the backend checks every request.

export interface AdminPage {
    path: string
    label: string
    icon: string
    permission: Permission
}

export const ADMIN_PAGES: readonly AdminPage[] = [
    { path: '/admin/knowledge-base', label: 'Knowledge Base', icon: 'kb', permission: 'kb.read' },
    { path: '/admin/users', label: 'Users', icon: 'users', permission: 'users.read' },
    {
        path: '/admin/user-online',
        label: 'User Online',
        icon: 'online-users',
        permission: 'users.read',
    },
    {
        path: '/admin/history-online',
        label: 'History Online',
        icon: 'history-online',
        permission: 'users.sensitive.read',
    },
    {
        path: '/admin/audit-log',
        label: 'Audit Log',
        icon: 'audit-log',
        permission: 'audit.read.account',
    },
]

export const adminPagesFor = (role: Role | null | undefined): AdminPage[] =>
    ADMIN_PAGES.filter((page) => roleHasPermission(role, page.permission))

/**
 * Where a navigation into the admin area must go instead, or null when it may stay:
 * a role with no admin permission goes to the account page; a session the admin area refused for
 * the staff MFA rule (feat-247) goes to the account's security section, which explains it;
 * `/admin` itself and a page the role may not see go to the first page it may see.
 */
export function adminRedirect(
    path: string,
    permission: Permission | undefined,
    role: Role | null | undefined,
    mfaRefusal: StaffMfaReason | null = null,
): string | null {
    if (!isStaffRole(role)) return '/account'
    if (mfaRefusal !== null) return staffMfaTarget(mfaRefusal)
    const first = adminPagesFor(role)[0]?.path ?? '/account'
    const normalized = path.replace(/\/+$/, '')
    if (normalized === '/admin') return first
    if (permission !== undefined && !roleHasPermission(role, permission)) return first
    return null
}
