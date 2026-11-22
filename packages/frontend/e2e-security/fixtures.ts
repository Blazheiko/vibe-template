export const PORT = 3000
export const ORIGIN = `http://localhost:${PORT}`
// Seeded by global-setup.ts (pnpm --filter backend db:seed --demo).
export const USER_1 = { email: 'csrf-e2e-user@example.test', password: 'csrf-e2e-pass-1' }
// feat-247: the seeded admin has an authenticator app of this key (SEED_ADMIN_TOTP_SECRET).
export const USER_2 = {
    email: 'csrf-e2e-admin@example.test',
    password: 'csrf-e2e-pass-2',
    totpSecret: 'JBSWY3DPEHPK3PXPCSRFE2EADMINTOTP',
}
