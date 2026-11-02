import { parseBoolean } from './parse-boolean.js'
import { parseInteger } from './read-int.js'
import type { IntRange } from './read-int.js'

/**
 * Reads typed values from an environment and keeps the problems it finds, so that a config module
 * reports all of them at once through `validateRuntimeConfig` instead of crashing on the first.
 */
export interface EnvReader {
    int(name: string, fallback: number, range: IntRange): number
    bool(name: string, fallback: boolean): boolean
    /** Every problem found so far, joined, or `null`. */
    readonly error: string | null
}

export function createEnvReader(env: NodeJS.ProcessEnv = process.env): EnvReader {
    const errors: string[] = []
    // The same variable can be read twice (a shared window); say it once
    const report = (error: string | null): void => {
        if (error !== null && !errors.includes(error)) errors.push(error)
    }

    return {
        int(name, fallback, range): number {
            const result = parseInteger(name, env[name], fallback, range)
            report(result.error)
            return result.value
        },
        bool(name, fallback): boolean {
            const result = parseBoolean(name, env[name], fallback)
            report(result.error)
            return result.value
        },
        get error(): string | null {
            return errors.length > 0 ? errors.join('; ') : null
        },
    }
}
