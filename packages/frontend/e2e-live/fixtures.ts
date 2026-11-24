// A port of its own: a developer's backend on 3000 and the security run (e2e-security) can stay up.
export const PORT = 3100
export const ORIGIN = `http://localhost:${String(PORT)}`
// The backend sends its mail here (SMTP_* in playwright.live.config.ts); mail-sink.ts listens.
export const SMTP_PORT = 2526
// Throwaway database and Redis key prefix: the run never touches a developer's data.
export const DB_NAME = 'vibe_e2e_live'
export const REDIS_PREFIX = 'e2e-live:'
// feat-248: the run with MFA_STAFF_FACTOR=passkey (playwright.live-passkey.config.ts) has a
// database of its own: the seeded admin gets a passkey there, which the other specs' TOTP sign-in
// of the same admin must not meet.
export const DB_NAME_PASSKEY = 'vibe_e2e_live_passkey'
// The step-up window of that run (AUTH_REAUTH_WINDOW_SECONDS, the smallest the backend accepts):
// reauth-step-up.spec.ts waits it out so a sensitive action asks for a step-up (ReauthDialog).
export const REAUTH_WINDOW_SECONDS_SHORT = 30
// feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 2): the API path of the run. The default
// run serves `/api`; playwright.live-prefix.config.ts builds and starts one with another prefix
// (API_PATH_PREFIX), so the MFA cookies are shown to work whatever the prefix.
export const API_PREFIX = process.env.E2E_API_PREFIX ?? 'api'
export const API = `/${API_PREFIX}`
// That run's database.
export const DB_NAME_PREFIX = 'vibe_e2e_live_prefix'

// Verified accounts, seeded by global-setup.ts (pnpm --filter backend db:seed --demo).
export const USER_1 = { email: 'live-e2e-user@example.test', password: 'live-e2e-pass-1' }
// feat-247: the seeded admin has an authenticator app of this key (SEED_ADMIN_TOTP_SECRET), so it
// passes the staff MFA rule; loginInUi answers the second step with its code.
export const USER_2 = {
    email: 'live-e2e-admin@example.test',
    password: 'live-e2e-pass-2',
    totpSecret: 'JBSWY3DPEHPK3PXPLIVEE2EADMINTOTP',
}
