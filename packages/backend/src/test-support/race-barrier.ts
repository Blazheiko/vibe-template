// Helpers for *.pg.test.ts that race two requests against each other.

import { vi } from 'vitest'

/**
 * Holds the first caller of `method` after it has read until a second caller has read too,
 * so both requests have passed the check before either writes: the race, made
 * deterministic. Restore with `vi.restoreAllMocks()`.
 */
export const bothReadBeforeEitherWrites = <T extends object>(
    repository: T,
    method: keyof T & string,
): void => {
    const original = (repository[method] as (...args: unknown[]) => Promise<unknown>).bind(
        repository,
    )
    let readers = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    vi.spyOn(repository, method as never).mockImplementation((async (...args: unknown[]) => {
        const result = await original(...args)
        readers += 1
        if (readers >= 2) release()
        await gate
        return result
    }) as never)
}

/**
 * Waits until at least `count` backends of the current database wait for a lock (a row lock
 * held by the test, say), so requests started one after another queue in that order. The PG
 * suites run one file at a time, so the waiters are the ones the test started.
 */
export const waitForLockWaiters = async (
    execute: (query: string) => Promise<{ rows: unknown[] }>,
    count: number,
    timeoutMs = 5000,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const { rows } = await execute(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
        const [row] = rows as [{ n: number }]
        if (row.n >= count) return
        if (Date.now() > deadline) {
            throw new Error(`expected ${String(count)} lock waiters, saw ${String(row.n)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}
