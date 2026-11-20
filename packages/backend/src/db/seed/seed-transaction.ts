import type { AuditLogger } from '#app/services/audit/audit-actor.js'
import { auditService } from '#app/services/audit/audit-service.js'
import type { SeedReport } from './run-seed.js'

/**
 * Runs the seed in one transaction and logs its audit events once it committed (feat-235, Р12): a
 * seed that rolls back leaves no admin, no event and no log line.
 */
export async function seedCommitted<TTx>(
    transaction: (work: (tx: TTx) => Promise<SeedReport>) => Promise<SeedReport>,
    work: (tx: TTx) => Promise<SeedReport>,
    log: AuditLogger,
): Promise<SeedReport> {
    const report = await transaction(work)
    auditService.logCommitted(log, report.auditEvents)
    return report
}
