ALTER TABLE "llm_text_usage" ADD COLUMN "prompt_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "llm_text_usage" ADD COLUMN "prompt_chars" integer;