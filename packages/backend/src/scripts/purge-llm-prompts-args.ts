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
        } else {
            throw new Error(`Unknown argument "${arg}". Use --dry-run, --all, --days=<n>.`)
        }
    }

    // Prompts not kept: whatever text is still in the table is a leftover (from before, or from
    // a switch-off) and goes. Kept: only what is past the retention.
    const purgeAll = all || !usage.storePrompts
    return {
        olderThan: purgeAll ? null : new Date(now.getTime() - days * DAY_MS),
        dryRun,
    }
}
