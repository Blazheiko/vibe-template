import readinessProbe from '#database/readiness-probe.js'

export const healthRepository = {
    /**
     * Throws when PostgreSQL does not answer within the readiness deadline, or while the previous
     * probe is still running (feat-113: its own connection, one probe at a time).
     */
    async pingDatabase(): Promise<void> {
        await readinessProbe.ping()
    },
}
