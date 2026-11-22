import { describe, expect, it } from 'vitest'

import { isStaffApiRoute, isStaffMfaReason, staffMfaTarget } from '../staff-mfa'

// feat-247 (Р10): the refusals of the staff MFA rule and where they lead.
describe('staff MFA helpers', () => {
    it('knows the two reasons of the rule and nothing else', () => {
        expect(isStaffMfaReason('mfa_required')).toBe(true)
        expect(isStaffMfaReason('mfa_session_required')).toBe(true)
        expect(isStaffMfaReason('reauth_required')).toBe(false)
        expect(isStaffMfaReason(undefined)).toBe(false)
        expect(isStaffMfaReason(['mfa_required'])).toBe(false)
    })

    it('leads to the security section of the account with the reason', () => {
        expect(staffMfaTarget('mfa_required')).toBe('/account?section=security&reason=mfa_required')
        expect(staffMfaTarget('mfa_session_required')).toBe(
            '/account?section=security&reason=mfa_session_required',
        )
    })

    it('recognises the requests of the admin area', () => {
        expect(isStaffApiRoute('/api/admin/users')).toBe(true)
        expect(isStaffApiRoute('/api/admin?x=1')).toBe(true)
        expect(isStaffApiRoute('/api/prompts')).toBe(true)
        expect(isStaffApiRoute('/api/prompts/support/test')).toBe(true)
        expect(isStaffApiRoute('/api/account/access')).toBe(false)
        expect(isStaffApiRoute('/api/administrators')).toBe(false)
        expect(isStaffApiRoute('/api/auth/login?next=/admin')).toBe(false)
    })
})
