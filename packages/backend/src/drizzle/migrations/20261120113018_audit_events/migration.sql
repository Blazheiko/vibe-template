CREATE TYPE "audit_actor_kind" AS ENUM('user', 'proof_holder', 'system');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY,
	"occurred_at" timestamp(6) NOT NULL,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_user_id" bigint,
	"actor_role" "user_role",
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(64) NOT NULL,
	"target_user_id" bigint,
	"request_id" uuid,
	"changes" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" ("occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_target_user_idx" ON "audit_events" ("target_user_id","occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_actor_user_idx" ON "audit_events" ("actor_user_id","occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" ("target_type","target_id","occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" ("action","occurred_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_request_id_idx" ON "audit_events" ("request_id") WHERE "request_id" IS NOT NULL;--> statement-breakpoint
-- feat-235 (Р2): an audit entry is never changed. The first trigger of these migrations, written
-- by hand: the Drizzle snapshot does not know triggers, so `db:generate` neither creates nor drops
-- it, and a later migration that recreates the table must add it again. DELETE stays allowed for
-- the retention job (audit-events-retention). This guards against the application, not against
-- the owner of the database, who can drop the trigger.
CREATE FUNCTION "audit_events_no_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events rows cannot be updated' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update" BEFORE UPDATE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit_events_no_update"();
