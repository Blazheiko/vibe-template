CREATE TABLE "oauth_link_verifications" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_user_id" varchar(255) NOT NULL,
	"provider_email" varchar(255) NOT NULL,
	"provider_name" varchar(255),
	"provider_avatar" varchar(500),
	"target_email" varchar(255) NOT NULL,
	"session_binding_hash" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL CONSTRAINT "oauth_link_verifications_token_hash_key" UNIQUE,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "target_email" varchar(255);--> statement-breakpoint
CREATE INDEX "oauth_link_verifications_user_id_provider_idx" ON "oauth_link_verifications" ("user_id","provider");--> statement-breakpoint
ALTER TABLE "oauth_link_verifications" ADD CONSTRAINT "oauth_link_verifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;