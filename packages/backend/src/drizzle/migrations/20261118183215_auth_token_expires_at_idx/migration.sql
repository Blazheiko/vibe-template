CREATE INDEX "email_link_verifications_expires_at_idx" ON "email_link_verifications" ("expires_at");--> statement-breakpoint
CREATE INDEX "email_verifications_expires_at_idx" ON "email_verifications" ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_link_verifications_expires_at_idx" ON "oauth_link_verifications" ("expires_at");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens" ("expires_at");