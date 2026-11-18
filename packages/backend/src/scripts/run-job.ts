import 'dotenv/config'

import schedulerConfig from '../config/scheduler.js'
import { pool } from '../database/db.js'
import redis, { redisHealth } from '../database/redis.js'
import { createAppScheduler } from '../app/scheduler/app-scheduler.js'
import { jobs } from '../app/scheduler/jobs/index.js'
import { exitCodeOf, parseRunJobArgs } from './run-job-args.js'
import { waitForRedisReady } from './redis-ready.js'

// Runs one scheduled job now (feat-222, scheduler plan Р9):
//
//   pnpm --filter backend job:run <name> [--dry-run]
//
// Takes the same lease as the scheduled run (sched:lease:<name>), so it never runs next to it:
// while the lease is held it answers "busy" with exit code 75 (EX_TEMPFAIL). It does not touch the
// schedule state (last success, backoff). Needs Redis. SIGINT/SIGTERM abort the run (exit 130).
async function main(): Promise<number> {
    if (schedulerConfig.configError !== null) {
        throw new Error(`Invalid scheduler configuration: ${schedulerConfig.configError}`)
    }
    const { name, dryRun } = parseRunJobArgs(
        process.argv.slice(2),
        jobs.map((job) => job.name),
    )

    const controller = new AbortController()
    const interrupt = (): void => {
        controller.abort(new Error('interrupted'))
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)

    await waitForRedisReady(redis)
    const result = await createAppScheduler().runOnce(name, { dryRun, signal: controller.signal })

    if (result.outcome === 'skipped-locked') {
        console.log(`Busy: ${name} is running elsewhere; try again later.`)
    } else if (result.outcome === 'ok') {
        console.log(
            dryRun
                ? `Dry run of ${name}: matched ${String(result.matched)}, changed 0.`
                : `${name}: matched ${String(result.matched)}, changed ${String(result.changed)}.`,
        )
    } else {
        const reason = result.error instanceof Error ? `: ${result.error.message}` : ''
        console.error(
            `${name} ended with ${result.outcome}${reason} (matched ${String(result.matched)}, changed ${String(result.changed)}).`,
        )
    }
    return exitCodeOf(result.outcome)
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
        // quit() is refused while the client is still connecting (no offline queue), and the
        // socket would then keep the process alive once it connects.
        redis.disconnect()
    })
