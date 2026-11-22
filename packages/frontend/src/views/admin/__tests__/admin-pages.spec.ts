import { describe, expect, it } from 'vitest'

import { adminPagesFor, adminRedirect } from '../admin-pages'

// feat-240 (Р10): the menu and the router read one list of admin pages.
describe('admin pages by role', () => {
    it.each([
        ['user', []],
        [
            'support_operator',
            ['/admin/knowledge-base', '/admin/users', '/admin/user-online', '/admin/audit-log'],
        ],
        ['kb_editor', ['/admin/knowledge-base']],
        ['user_admin', ['/admin/users', '/admin/user-online', '/admin/audit-log']],
        [
            'admin',
            [
                '/admin/knowledge-base',
                '/admin/users',
                '/admin/user-online',
                '/admin/history-online',
                '/admin/audit-log',
            ],
        ],
    ] as const)('%s sees its pages', (role, paths) => {
        expect(adminPagesFor(role).map((page) => page.path)).toEqual(paths)
    })

    it('sends a role without admin permissions to the account page', () => {
        expect(adminRedirect('/admin/users', 'users.read', 'user')).toBe('/account')
        expect(adminRedirect('/admin', undefined, undefined)).toBe('/account')
    })

    it('sends /admin to the first page the role may see', () => {
        expect(adminRedirect('/admin', undefined, 'kb_editor')).toBe('/admin/knowledge-base')
        expect(adminRedirect('/admin/', undefined, 'user_admin')).toBe('/admin/users')
    })

    it('sends a page the role may not see to its first page, and lets the others stay', () => {
        expect(
            adminRedirect('/admin/history-online', 'users.sensitive.read', 'support_operator'),
        ).toBe('/admin/knowledge-base')
        expect(adminRedirect('/admin/users', 'users.read', 'kb_editor')).toBe(
            '/admin/knowledge-base',
        )
        expect(adminRedirect('/admin/knowledge-base', 'kb.read', 'kb_editor')).toBeNull()
        expect(adminRedirect('/admin/history-online', 'users.sensitive.read', 'admin')).toBeNull()
    })

    // feat-247 (Р10): a session the admin area refused for the staff MFA rule.
    it('sends a staff session refused for the MFA rule to the security section', () => {
        expect(adminRedirect('/admin/users', 'users.read', 'admin', 'mfa_required')).toBe(
            '/account?section=security&reason=mfa_required',
        )
        expect(adminRedirect('/admin', undefined, 'kb_editor', 'mfa_session_required')).toBe(
            '/account?section=security&reason=mfa_session_required',
        )
        // A role without admin permissions still goes to the account page itself.
        expect(adminRedirect('/admin/users', 'users.read', 'user', 'mfa_required')).toBe('/account')
        expect(adminRedirect('/admin/users', 'users.read', 'admin', null)).toBeNull()
    })
})
