// feat-235: the actor of an audited change made by a test outside a request, and the events a
// test wrote.

import { randomUUID } from 'node:crypto'
import { vi, type Mock } from 'vitest'

import type { UserAuditActor } from '#app/services/audit/audit-actor.js'

type LogSpy = Mock<(obj: unknown, msg?: unknown, ...args: unknown[]) => void>

export interface TestAuditActor extends UserAuditActor {
    requestId: string
    logger: { info: LogSpy }
}

/**
 * A signed-in admin with a request id of its own, so a test finds exactly its events; its logger
 * is a spy, so a test can read the committed-event lines.
 */
export const testAdminActor = (userId = 1n): TestAuditActor => ({
    kind: 'user',
    userId,
    role: 'admin',
    requestId: randomUUID(),
    proof: null,
    source: null,
    logger: { info: vi.fn<(obj: unknown, msg?: unknown, ...args: unknown[]) => void>() },
})

/** The `audit event` lines a spy logger received. */
export const auditLogLines = (logger: { info: LogSpy }): unknown[] =>
    logger.info.mock.calls.filter((call) => call[1] === 'audit event').map((call) => call[0])
