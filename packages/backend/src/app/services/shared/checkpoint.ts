// feat-222: a synchronous check a long-running task calls immediately before every SQL step
// (no `await` between the call and the query). It throws when the task must stop: its signal was
// aborted, or its lease can no longer be trusted. Lives here, not in app/scheduler, so services and
// repositories can take one without importing the scheduler.
export type Checkpoint = () => void

/** For calls made outside a scheduled job (tests, a one-off script without a lease). */
export const noCheckpoint: Checkpoint = () => undefined
