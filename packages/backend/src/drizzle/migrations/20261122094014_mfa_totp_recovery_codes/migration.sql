CREATE TABLE "mfa_recovery_codes" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"batch_id" varchar(21) NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_recovery_codes_user_code_unique" UNIQUE("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "totp_factors" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL CONSTRAINT "totp_factors_user_id_unique" UNIQUE,
	"enrollment_id" varchar(32) NOT NULL CONSTRAINT "totp_factors_enrollment_id_unique" UNIQUE,
	"secret_ciphertext" bytea NOT NULL,
	"key_id" varchar(16) NOT NULL,
	"last_used_step" bigint NOT NULL,
	"confirmed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_unused_idx" ON "mfa_recovery_codes" ("user_id") WHERE "used_at" IS NULL;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "totp_factors" ADD CONSTRAINT "totp_factors_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check", ADD CONSTRAINT "notifications_kind_check" CHECK ("kind" IN ('security.new_sign_in', 'security.method_added', 'security.method_removed', 'security.password_changed', 'security.password_reset', 'security.logout_all', 'security.session_revoked', 'security.account_claimed', 'security.mfa_enabled', 'security.mfa_disabled', 'security.recovery_codes_regenerated', 'security.recovery_code_used', 'support.reply'));