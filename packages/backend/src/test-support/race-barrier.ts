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
