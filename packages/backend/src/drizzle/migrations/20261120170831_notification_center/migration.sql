CREATE TABLE "notification_preferences" (
	"user_id" bigint,
	"category" varchar(32),
	"channel" varchar(16),
	"enabled" boolean NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pkey" PRIMARY KEY("user_id","category","channel"),
	CONSTRAINT "notification_preferences_category_check" CHECK ("category" IN ('security', 'support')),
	CONSTRAINT "notification_preferences_channel_check" CHECK ("channel" IN ('push', 'email'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"category" varchar(32) NOT NULL,
	"kind" varchar(64) NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"link" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp,
	CONSTRAINT "notifications_category_check" CHECK ("category" IN ('security', 'support')),
	CONSTRAINT "notifications_kind_check" CHECK ("kind" IN ('security.new_sign_in', 'security.method_added', 'security.method_removed', 'security.password_changed', 'security.password_reset', 'security.logout_all', 'security.session_revoked', 'security.account_claimed', 'support.reply')),
	CONSTRAINT "notifications_link_check" CHECK ("link" IS NULL OR "link" LIKE '/%')
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN "notification_types";--> statement-breakpoint
CREATE INDEX "notifications_user_id_id_idx" ON "notifications" ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" ("user_id","id" DESC NULLS LAST) WHERE "read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" ("created_at");--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;