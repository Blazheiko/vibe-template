CREATE TYPE "llm_text_usage_status" AS ENUM('completed', 'aborted', 'failed');--> statement-breakpoint
ALTER TABLE "llm_text_usage" ADD COLUMN "status" "llm_text_usage_status" DEFAULT 'completed'::"llm_text_usage_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_text_usage" ADD COLUMN "tokens_estimated" boolean DEFAULT false NOT NULL;