import { describe, expect, it } from 'vitest'

import { canChangeRoleOf, roleChangeErrorText, roleOptionsFor } from '../role-options'

// feat-241 (Р6, Р10): the dialog offers what the delegation policy allows.
const target = (role: Parameters<typeof roleOptionsFor>[1]['role'], emailVerified = true) => ({
    id: '9',
    role,
    emailVerified,
})

describe('role options', () => {
    it('gives an admin every other role, a user_admin only the roles it manages', () => {
        expect(roleOptionsFor('admin', target('user')).map((option) => option.role)).toEqual([
            'support_operator',
            'kb_editor',
            'user_admin',
            'admin',
        ])
        expect(roleOptionsFor('user_admin', target('user')).map((option) => option.role)).toEqual([
            'support_operator',
            'kb_editor',
        ])
        expect(roleOptionsFor('user_admin', target('admin'))).toEqual([])
    })

    it('disables the staff roles for an account without a verified email', () => {
        const options = roleOptionsFor('admin', target('kb_editor', false))
        expect(options.find((option) => option.role === 'user')?.disabledReason).toBeNull()
        expect(options.find((option) => option.role === 'admin')?.disabledReason).toBe(
            'Needs a verified email',
        )
    })

    it('offers no change of the own role, nor of a user outside the policy', () => {
        expect(canChangeRoleOf({ id: '9', role: 'admin' }, target('user'))).toBe(false)
        expect(canChangeRoleOf({ id: '1', role: 'admin' }, target('admin'))).toBe(true)
        expect(canChangeRoleOf({ id: '1', role: 'user_admin' }, target('user_admin'))).toBe(false)
        expect(canChangeRoleOf({ id: '1', role: 'user_admin' }, target('kb_editor'))).toBe(true)
        expect(canChangeRoleOf({ id: '1', role: 'support_operator' }, target('user'))).toBe(false)
        expect(canChangeRoleOf({ id: '1', role: undefined }, target('user'))).toBe(false)
    })

    it.each([
        [409, 'last_admin', 'The last administrator keeps the role.'],
        [409, 'identity_unverified', 'A staff role needs a verified email.'],
        [404, undefined, 'The user no longer exists.'],
        [403, undefined, 'You may not change this role.'],
        [
            409,
            'mfa_not_enrolled',
            'A staff role needs two-step sign-in: the user sets it up in the account first.',
        ],
        [500, undefined, 'The role could not be changed.'],
    ])('says what a %i %s means', (status, reason, text) => {
        expect(roleChangeErrorText(status, reason)).toBe(text)
    })
})
