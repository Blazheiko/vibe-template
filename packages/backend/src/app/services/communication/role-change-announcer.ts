// feat-240 (Р8): after a committed role change, the instances re-read the role of the user's
// open connections. Filled in by T6 (server bus event user_role_changed); a no-op until then.
export const announceRoleChanged = (_userId: bigint): void => {}
