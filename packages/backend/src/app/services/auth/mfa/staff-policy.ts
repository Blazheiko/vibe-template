import {
    staffMfaPolicy,
    staffSessionOk,
    type SessionAuthState,
    type StaffMfaPolicy,
} from 'shared/mfa'

import mfaConfig from '#config/mfa.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10, Р11): the staff MFA policy of this deployment.
// Every backend consumer (role assignment, MFA reset, can:, ws_can:, ws-role-sync, the admin
// channel) asks it here, so the mode is read in one place.

export const staffPolicy = (): StaffMfaPolicy => staffMfaPolicy(mfaConfig.staffFactor)

/** Whether a staff session may use staff permissions now (always, while the rule is off). */
export function staffSessionMeets(
    auth: SessionAuthState | undefined | null,
    now = Date.now(),
): boolean {
    if (!mfaConfig.requiredForStaff) return true
    return staffSessionOk(staffPolicy(), auth, now, mfaConfig.staffFactorMaxAgeHours)
}

/** When the staff session stops meeting the rule, in ms; null when it does not now. */
export function staffSessionDeadline(
    auth: SessionAuthState | undefined | null,
    now = Date.now(),
): number | null {
    if (!mfaConfig.requiredForStaff) return Number.POSITIVE_INFINITY
    return staffPolicy().sessionDeadline(auth, now, mfaConfig.staffFactorMaxAgeHours)
}
