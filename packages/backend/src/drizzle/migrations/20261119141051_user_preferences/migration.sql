CREATE TABLE "user_preferences" (
	"user_id" bigint PRIMARY KEY,
	"locale" varchar(8),
	"time_zone" varchar(64),
	"theme" varchar(16),
	"color_theme" varchar(32),
	"font_size" smallint,
	"revision" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_theme_check" CHECK ("theme" IN ('light', 'dark')),
	CONSTRAINT "user_preferences_color_theme_check" CHECK ("color_theme" IN ('ocean', 'mint', 'lavender', 'rose', 'sunset', 'monochrome')),
	CONSTRAINT "user_preferences_font_size_check" CHECK ("font_size" BETWEEN 14 AND 20),
	CONSTRAINT "user_preferences_revision_check" CHECK ("revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;