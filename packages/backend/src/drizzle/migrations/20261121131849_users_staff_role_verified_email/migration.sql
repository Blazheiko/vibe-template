-- feat-240 (docs/plan/roles-permissions-plan.md, Р3, Р6 rule 3): a staff role only on an account
-- with a verified email. An unverified account can be claimed by the owner of its address
-- (claimLocked keeps users.role), so a role given before the verification would move with it.
-- Fails on a database that already has an unverified staff account: verify its email
-- (UPDATE users SET email_verified_at = now() WHERE id = ...) or set its role back to 'user'.
ALTER TABLE "users" ADD CONSTRAINT "users_staff_role_verified_email" CHECK ("role" = 'user' OR "email_verified_at" IS NOT NULL);
