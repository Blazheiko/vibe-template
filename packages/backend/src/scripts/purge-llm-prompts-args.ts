// What `llm:purge-prompts` is asked to do. A purge cannot be undone, so anything it does not
// understand is an error, not a guess.

const DAY_MS = 86_400_000

export interface PurgePlan {
    /** Purge text created at or before this moment; null purges all of it. */
    olderThan: Date | null
    dryRun: boolean
}

export function planPurge(
    args: readonly string[],
    usage: { storePrompts: boolean; retentionDays: number },
    now: Date,
): PurgePlan {
    let all = false
    let dryRun = false
    let days = usage.retentionDays
    let daysGiven = false

    for (const arg of args) {
        if (arg === '--all') {
            all = true
        } else if (arg === '--dry-run') {
            dryRun = true
        } else if (arg.startsWith('--days=')) {
            const raw = arg.slice('--days='.length)
            if (!/^[1-9]\d*$/.test(raw))
                throw new Error(`--days must be an integer >= 1, got "${raw}"`)
            days = Number(raw)
            daysGiven = true
        } else {
            throw new Error(`Unknown argument "${arg}". Use --dry-run, --all, --days=<n>.`)
        }
    }

    // Prompts not kept: whatever text is still in the table is a leftover (from before, or from
    // a switch-off) and goes. Kept: only what is past the retention.
    const purgeAll = all || !usage.storePrompts
    // feat-136 (L8): --days that cannot apply is an error, not ignored: the purge would remove
    // all stored text, wider than the operator asked for, and that cannot be undone.
    if (daysGiven && purgeAll) {
        throw new Error(
            all
                ? '--days cannot be combined with --all: --all removes all stored prompt text.'
                : '--days has no effect with AI_USAGE_STORE_PROMPTS=false: all stored prompt text would be removed. Pass --all to confirm that.',
        )
    }
    return {
        olderThan: purgeAll ? null : new Date(now.getTime() - days * DAY_MS),
        dryRun,
    }
}

/**
 * feat-136 (L8): the script reads the database pool and the AI settings outside the server's start
 * checks; a configuration error stops it instead of running on fallbacks. Null when both are fine.
 */
export function purgeConfigError(errors: {
    database: string | null
    ai: string | null
}): string | null {
    if (errors.database !== null) return `Invalid database configuration: ${errors.database}`
    if (errors.ai !== null) return `Invalid AI configuration: ${errors.ai}`
    return null
}
