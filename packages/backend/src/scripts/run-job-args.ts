import type { Outcome } from '../app/scheduler/job.js'

// What `job:run` is asked to do (feat-222, scheduler plan Р9).

export interface RunJobArgs {
    name: string
    dryRun: boolean
}

export const USAGE = 'Usage: pnpm --filter backend job:run <name> [--dry-run]'

export function parseRunJobArgs(args: readonly string[], known: readonly string[]): RunJobArgs {
    let name: string | undefined
    let dryRun = false
    for (const arg of args) {
        if (arg === '--dry-run') dryRun = true
        else if (arg.startsWith('-')) throw new Error(`Unknown argument "${arg}". ${USAGE}`)
        else if (name === undefined) name = arg
        else throw new Error(`Only one job name is accepted, got "${name}" and "${arg}". ${USAGE}`)
    }
    if (name === undefined) throw new Error(`No job name given. ${USAGE}`)
    if (!known.includes(name)) {
        const list = known.length > 0 ? known.join(', ') : 'none registered'
        throw new Error(`Unknown job "${name}". Jobs: ${list}.`)
    }
    return { name, dryRun }
}

/** 75 = EX_TEMPFAIL (busy, try later), 130 = interrupted, 1 = the run failed. */
export function exitCodeOf(outcome: Outcome): number {
    switch (outcome) {
        case 'ok':
            return 0
        case 'skipped-locked':
        case 'skipped-backoff':
            return 75
        case 'shutdown':
            return 130
        case 'failed':
        case 'timeout':
        case 'lease-lost':
            return 1
    }
}
