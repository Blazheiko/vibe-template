import { nowUnixMs } from 'shared/brand'
import { isStaffRole, type Role } from 'shared/access'
import {
    MFA_REASONS,
    staffMfaPolicy,
    staffSessionOk,
    type SessionAuthState,
    type StaffFactorMode,
    type StaffMfaPolicy,
} from 'shared/mfa'

import mfaConfig from '#config/mfa.js'
import { conflict, type AppError } from '#app/services/shared/errors.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10, Р11): the staff MFA policy of this deployment.
// Every backend consumer (role assignment, factor removal, MFA reset, can:, ws_can:, ws-role-sync,
// the admin channel) asks it here, so the mode is read in one place.

export const staffPolicy = (): StaffMfaPolicy => staffMfaPolicy(mfaConfig.staffFactor)

/**
 * feat-248 (Р10): the factor the account's role needs, shown in the security section (a staff
 * member without a passkey sees a banner in the passkey mode); null without the requirement.
 */
export const staffFactorFor = (role: Role): StaffFactorMode | null =>
    mfaConfig.requiredForStaff && isStaffRole(role) ? staffPolicy().mode : null

/** Whether a staff session may use staff permissions now (always, while the rule is off). */
export function staffSessionMeets(
    auth: SessionAuthState | undefined | null,
    now = nowUnixMs(),
): boolean {
    if (!mfaConfig.requiredForStaff) return true
    return staffSessionOk(staffPolicy(), auth, now, mfaConfig.staffFactorMaxAgeHours)
}

/** When the staff session stops meeting the rule, in ms; null when it does not now. */
export function staffSessionDeadline(
    auth: SessionAuthState | undefined | null,
    now = nowUnixMs(),
): number | null {
    if (!mfaConfig.requiredForStaff) return Number.POSITIVE_INFINITY
    return staffPolicy().sessionDeadline(auth, now, mfaConfig.staffFactorMaxAgeHours)
}

/**
 * feat-248 (Р12): a factor removal that leaves a staff account without the factor its role needs
 * (`meetsStaffMfa` of signInCapability, counted on the state after the change under the user's
 * row lock) is refused while the rule is on. Only the reset by an administrator or the CLI may
 * leave the account so; it deliberately ends the staff access until a new factor is set up.
 */
export function staffFactorLossError(
    role: Role,
    after: { meetsStaffMfa: boolean },
): AppError | null {
    if (!mfaConfig.requiredForStaff || !isStaffRole(role) || after.meetsStaffMfa) return null
    return conflict(
        staffPolicy().mode === 'passkey'
            ? 'A staff role needs a passkey: add another passkey before removing this one'
            : 'A staff role needs a second factor: set up another one before removing this one',
        MFA_REASONS.mfaRequiredForRole,
    )
}
