// A port of its own: a developer's backend on 3000 and the security run (e2e-security) can stay up.
export const PORT = 3100
export const ORIGIN = `http://localhost:${String(PORT)}`
// The backend sends its mail here (SMTP_* in playwright.live.config.ts); mail-sink.ts listens.
export const SMTP_PORT = 2526
// Throwaway database and Redis key prefix: the run never touches a developer's data.
export const DB_NAME = 'vibe_e2e_live'
export const REDIS_PREFIX = 'e2e-live:'

// Verified accounts, seeded by global-setup.ts (pnpm --filter backend db:seed --demo).
export const USER_1 = { email: 'live-e2e-user@example.test', password: 'live-e2e-pass-1' }
export const USER_2 = { email: 'live-e2e-admin@example.test', password: 'live-e2e-pass-2' }
