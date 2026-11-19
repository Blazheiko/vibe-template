import 'dotenv/config'

import aiConfig from '../config/ai.js'
import databasePoolConfig from '../config/database-pool.js'
import { pool } from '../database/db.js'
import redis, { redisHealth } from '../database/redis.js'
import { withJobLease } from '../app/scheduler/job-lease.js'
import { llmPromptRetentionJob } from '../app/scheduler/jobs/llm-prompt-retention.js'
import { llmUsageService } from '../app/services/ai/usage/llm-usage-service.js'
import { planPurge, purgeConfigError } from '../app/services/ai/usage/prompt-purge-plan.js'
import { runPromptPurge } from './purge-llm-prompts-cli.js'
import { waitForRedisReady } from './redis-ready.js'

// Empties the stored prompt text of llm_text_usage (feat-065) and keeps its SHA-256 and length.
//
//   pnpm --filter backend llm:purge-prompts [--dry-run] [--all] [--days=<n>]
//
// With AI_USAGE_STORE_PROMPTS=false (the default) it removes all text still in the table.
// With true it removes text older than AI_USAGE_PROMPT_RETENTION_DAYS (--days overrides).
// --all removes it whatever the setting. The scheduled job `llm-prompt-retention` does the same
// every day (feat-224); this CLI takes that job's lease, so it needs Redis and answers "busy"
// (exit 75) while the job runs. SIGINT/SIGTERM stop it between batches (exit 130).
async function main(): Promise<number> {
    const configError = purgeConfigError({
        database: databasePoolConfig.configError,
        ai: aiConfig.configError,
    })
    if (configError !== null) throw new Error(configError)

    const plan = planPurge(
        process.argv.slice(2),
        {
            storePrompts: aiConfig.usage.storePrompts,
            retentionDays: aiConfig.usage.promptRetentionDays,
        },
        new Date(),
    )

    const controller = new AbortController()
    const interrupt = (): void => {
        controller.abort(new Error('interrupted'))
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)

    await waitForRedisReady(redis)
    return await runPromptPurge(plan, {
        job: llmPromptRetentionJob,
        withLease: withJobLease,
        purge: (options) => llmUsageService.purgePromptText(options),
        signal: controller.signal,
        print: (line) => {
            console.log(line)
        },
        printError: (line) => {
            console.error(line)
        },
    })
}

main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err)
        process.exitCode = 1
    })
    .finally(async () => {
        redisHealth.stop()
        await Promise.allSettled([pool.end(), redis.quit()])
        // quit() is refused while the client is still connecting (no offline queue).
        redis.disconnect()
    })
