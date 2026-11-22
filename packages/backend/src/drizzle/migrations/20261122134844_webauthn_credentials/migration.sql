CREATE TABLE "webauthn_credentials" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"credential_id" bytea NOT NULL CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE,
	"public_key" bytea NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"aaguid" uuid,
	"device_type" varchar(16) NOT NULL,
	"backed_up" boolean NOT NULL,
	"name" varchar(64) NOT NULL,
	"enrollment_id" varchar(32) NOT NULL CONSTRAINT "webauthn_credentials_enrollment_id_unique" UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "webauthn_user_handle" bytea;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webauthn_user_handle_key" UNIQUE("webauthn_user_handle");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials" ("user_id");--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check", ADD CONSTRAINT "notifications_kind_check" CHECK ("kind" IN ('security.new_sign_in', 'security.method_added', 'security.method_removed', 'security.password_changed', 'security.password_reset', 'security.logout_all', 'security.session_revoked', 'security.account_claimed', 'security.mfa_enabled', 'security.mfa_disabled', 'security.recovery_codes_regenerated', 'security.recovery_code_used', 'security.passkey_added', 'security.passkey_removed', 'support.reply'));