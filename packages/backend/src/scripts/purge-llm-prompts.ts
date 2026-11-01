import 'dotenv/config'

import aiConfig from '../config/ai.js'
import { pool } from '../database/db.js'
import { llmUsageService } from '../app/services/ai/usage/llm-usage-service.js'
import { planPurge } from './purge-llm-prompts-args.js'

// Empties the stored prompt text of llm_text_usage (feat-065) and keeps its SHA-256 and length.
//
//   pnpm --filter backend llm:purge-prompts [--dry-run] [--all] [--days=<n>]
//
// With AI_USAGE_STORE_PROMPTS=false (the default) it removes all text still in the table.
// With true it removes text older than AI_USAGE_PROMPT_RETENTION_DAYS (--days overrides).
// --all removes it whatever the setting. Run it from cron / a scheduler for a retention.
async function main(): Promise<void> {
    const plan = planPurge(
        process.argv.slice(2),
        {
            storePrompts: aiConfig.usage.storePrompts,
            retentionDays: aiConfig.usage.promptRetentionDays,
        },
        new Date(),
    )
    const scope =
        plan.olderThan === null
            ? 'all stored prompt text'
            : `prompt text before ${plan.olderThan.toISOString()}`

    const { matched } = await llmUsageService.purgePromptText(plan)

    console.log(
        plan.dryRun
            ? `Dry run: ${String(matched)} row(s) of ${scope} would be emptied.`
            : `Emptied ${String(matched)} row(s) of ${scope}.`,
    )
}

main()
    .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err)
        process.exitCode = 1
    })
    .finally(() => pool.end())
