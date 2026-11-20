import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AUDIT_ACTION_NAMES,
    AUDIT_ACTIONS,
    AUDIT_PAYLOAD_MAX_BYTES,
    buildAuditPayload,
    type AuditAction,
    type AuditContentFingerprint,
    type AuditInputs,
} from 'shared/audit'

const { insert } = vi.hoisted(() => ({ insert: vi.fn() }))

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#app/repositories/index.js', () => ({
    auditEventsRepository: { insert },
    readClockTimestamp: vi.fn(() => Promise.resolve('2026-11-20 10:00:00.123456')),
}))

const { assertAuditPayloadSize, auditService } = await import('./audit-service.js')
const { systemActor } = await import('./audit-actor.js')

const tx = {} as never
const log = { info: vi.fn() }
const userActor = {
    kind: 'user',
    userId: 5n,
    role: 'admin',
    requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    proof: null,
    source: null,
    logger: log,
} as const
const proofHolder = {
    kind: 'proof_holder',
    userId: null,
    role: null,
    requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    proof: 'email_link',
    source: null,
    logger: log,
} as const

beforeEach(() => {
    insert.mockReset()
    log.info.mockReset()
})

// ─── worst case (Р5) ────────────────────────────────────────────────────────────────────────
// The longest values the schemas and columns allow, in the three kinds of character that cost
// the most once serialized: a control character (6 bytes, \u0001), a quote (2 bytes, \") and a
// character outside the BMP (4 bytes for 2 UTF-16 units).
const KINDS = {
    control: (n: number) => '\u0001'.repeat(n),
    quote: (n: number) => '"'.repeat(n),
    astral: (n: number) => '😀'.repeat(Math.floor(n / 2)),
} as const

const TITLE_MAX = 255
const CATEGORY_MAX = 100
const MODEL_MAX = 100
const TOPIC_MAX = 100
const PROVIDER_MAX = 50
const MIME_MAX = 50
const OAUTH_PROVIDERS = 4

const worstFingerprint: AuditContentFingerprint = {
    changed: true,
    sha256Before: 'f'.repeat(64),
    sha256After: 'e'.repeat(64),
    charsBefore: 50_000,
    charsAfter: 49_999,
}

function worstInputs(str: (n: number) => string): { [A in AuditAction]: AuditInputs[A] } {
    // Two different values of the same length, so every field counts as changed.
    const other = (n: number) => `${str(n - 1)}x`
    const articleBefore = { title: str(TITLE_MAX), category: str(CATEGORY_MAX), isActive: true }
    const articleAfter = { title: other(TITLE_MAX), category: other(CATEGORY_MAX), isActive: false }
    return {
        'user.admin.created': {},
        'auth.password.changed': {},
        'auth.password.reset': { claimed: true },
        'auth.account.claimed': {
            passwordCleared: true,
            phoneRemoved: true,
            oauthRemoved: Array.from(
                { length: OAUTH_PROVIDERS },
                (_, i) => `${str(PROVIDER_MAX - 1)}${String(i)}`,
            ),
            pushSubscriptionsRemoved: Number.MAX_SAFE_INTEGER,
        },
        'auth.phone.linked': {},
        'auth.email.linked': {},
        'auth.oauth.linked': { provider: str(PROVIDER_MAX) },
        'auth.sign_in_method.unlinked': { method: 'oauth', provider: str(PROVIDER_MAX) },
        'auth.sessions.revoked_all': {},
        'auth.sessions.revoked_others': {},
        'kb.article.created': { after: articleBefore, content: worstFingerprint },
        'kb.article.updated': {
            before: articleBefore,
            after: articleAfter,
            content: worstFingerprint,
        },
        'kb.article.deleted': { before: articleBefore, content: worstFingerprint },
        'kb.screenshot.uploaded': { hadScreenshot: true, mime: str(MIME_MAX) },
        'kb.screenshot.removed': { hadScreenshot: true, mime: str(MIME_MAX) },
        'ai.prompt.updated': {
            before: {
                model: str(MODEL_MAX),
                temperature: 1.9999999999999998,
                maxTokens: 100_000,
                topic: str(TOPIC_MAX),
            },
            after: {
                model: other(MODEL_MAX),
                temperature: 1.234567890123457e-15,
                maxTokens: 99_999,
                topic: other(TOPIC_MAX),
            },
            content: worstFingerprint,
        },
    }
}

const actorMetaOf = (action: AuditAction) => {
    const kind = AUDIT_ACTIONS[action].actorKinds[0]
    if (kind === 'proof_holder') return { proof: 'oauth_provider_email' } as const
    if (kind === 'system') return { source: 'seed' } as const
    // A signed-in user's proof where the action records one.
    const metadata = AUDIT_ACTIONS[action].metadata
    return metadata !== null && 'proof' in metadata ? ({ proof: 'sms_code' } as const) : {}
}

const bytesOf = (action: AuditAction, str: (n: number) => string): number => {
    const payload = buildAuditPayload(
        action,
        worstInputs(str)[action] as never,
        actorMetaOf(action),
    )
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

describe('audit payload size, worst case', () => {
    for (const action of AUDIT_ACTION_NAMES) {
        for (const [kind, str] of Object.entries(KINDS)) {
            it(`${action} with ${kind} strings fits in ${String(AUDIT_PAYLOAD_MAX_BYTES)} bytes`, () => {
                const payload = buildAuditPayload(
                    action,
                    worstInputs(str)[action] as never,
                    actorMetaOf(action),
                )
                expect(() => {
                    assertAuditPayloadSize(payload)
                }).not.toThrow()
            })
        }
    }

    it('the largest cases are the ones the plan measured', () => {
        // An article update needs more than 4096 bytes, which is why the bound is 8192.
        const update = bytesOf('kb.article.updated', KINDS.control)
        expect(update).toBeGreaterThan(4096)
        expect(update).toBeGreaterThan(4500)
        expect(update).toBeLessThan(4700)
        const prompt = bytesOf('ai.prompt.updated', KINDS.control)
        expect(prompt).toBeGreaterThan(2700)
        expect(prompt).toBeLessThan(3000)
        const created = bytesOf('kb.article.created', KINDS.control)
        expect(created).toBeGreaterThan(2300)
        expect(created).toBeLessThan(2550)
    })

    it('refuses a payload one byte over the bound', () => {
        const envelope = Buffer.byteLength(
            JSON.stringify({ changes: null, metadata: { mime: '' } }),
        )
        const atBound = {
            changes: null,
            metadata: { mime: 'a'.repeat(AUDIT_PAYLOAD_MAX_BYTES - envelope) },
        }
        expect(Buffer.byteLength(JSON.stringify(atBound))).toBe(AUDIT_PAYLOAD_MAX_BYTES)
        expect(() => {
            assertAuditPayloadSize(atBound)
        }).not.toThrow()
        const over = { ...atBound, metadata: { mime: `${atBound.metadata.mime}a` } }
        expect(() => {
            assertAuditPayloadSize(over)
        }).toThrow(/8193 bytes/)
    })
})

describe('auditService.record', () => {
    it('writes one row per event with the stamp, the actor and the projected payload', async () => {
        const stamp = await auditService.stamp(tx)
        const recorded = await auditService.record(tx, stamp, proofHolder, [
            {
                action: 'auth.password.reset',
                targetId: '9',
                targetUserId: 9n,
                input: { claimed: false },
            },
        ])
        expect(recorded).toEqual([
            { action: 'auth.password.reset', targetType: 'user', targetId: '9' },
        ])
        expect(insert).toHaveBeenCalledTimes(1)
        expect(insert).toHaveBeenCalledWith(
            [
                {
                    occurredAt: '2026-11-20 10:00:00.123456',
                    actorKind: 'proof_holder',
                    actorUserId: null,
                    actorRole: null,
                    action: 'auth.password.reset',
                    targetType: 'user',
                    targetId: '9',
                    targetUserId: 9n,
                    requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
                    changes: null,
                    metadata: { claimed: false, proof: 'email_link' },
                },
            ],
            tx,
        )
    })

    it('several events of one change share the stamp and go in one insert', async () => {
        const stamp = await auditService.stamp(tx)
        await auditService.record(tx, stamp, proofHolder, [
            {
                action: 'auth.password.reset',
                targetId: '9',
                targetUserId: 9n,
                input: { claimed: true },
            },
            {
                action: 'auth.account.claimed',
                targetId: '9',
                targetUserId: 9n,
                input: {
                    passwordCleared: false,
                    phoneRemoved: true,
                    oauthRemoved: ['github', 'google', 'github'],
                    pushSubscriptionsRemoved: 1,
                },
            },
        ])
        expect(insert).toHaveBeenCalledTimes(1)
        const rows = insert.mock.calls[0]?.[0] as { occurredAt: string; metadata: unknown }[]
        expect(rows.map((row) => row.occurredAt)).toEqual([stamp.occurredAt, stamp.occurredAt])
        expect(rows[1]?.metadata).toEqual({
            proof: 'email_link',
            passwordCleared: false,
            phoneRemoved: true,
            oauthRemoved: ['github', 'google'],
            pushSubscriptionsRemoved: 1,
        })
    })

    it('refuses a proof holder without its proof', async () => {
        const stamp = await auditService.stamp(tx)
        await expect(
            auditService.record(tx, stamp, { ...proofHolder, proof: null } as never, [
                { action: 'auth.password.reset', targetId: '9', input: { claimed: false } },
            ]),
        ).rejects.toThrow(/needs its proof/)
        expect(insert).not.toHaveBeenCalled()
    })

    it('refuses an actor kind the action does not allow', async () => {
        const stamp = await auditService.stamp(tx)
        await expect(
            auditService.record(tx, stamp, userActor, [
                { action: 'auth.password.reset', targetId: '9', input: { claimed: false } },
            ]),
        ).rejects.toThrow(/cannot be done by a user actor/)
        await expect(
            auditService.record(tx, stamp, systemActor('seed'), [
                { action: 'kb.article.deleted', targetId: '1', input: {} as never },
            ]),
        ).rejects.toThrow(/cannot be done by a system actor/)
        expect(insert).not.toHaveBeenCalled()
    })

    it('refuses an oversized payload before the insert', async () => {
        const stamp = await auditService.stamp(tx)
        await expect(
            auditService.record(tx, stamp, userActor, [
                {
                    action: 'kb.screenshot.uploaded',
                    targetId: '1',
                    input: { hadScreenshot: false, mime: 'x'.repeat(AUDIT_PAYLOAD_MAX_BYTES) },
                },
            ]),
        ).rejects.toThrow(/bytes, more than/)
        expect(insert).not.toHaveBeenCalled()
    })
})

describe('auditService.logCommitted', () => {
    it('logs action and target of each event, never its changes', () => {
        const requestLog = { info: vi.fn() }
        auditService.logCommitted(requestLog, [
            { action: 'kb.article.updated', targetType: 'kb_article', targetId: '3' },
        ])
        expect(requestLog.info).toHaveBeenCalledTimes(1)
        expect(requestLog.info).toHaveBeenCalledWith(
            { audit: { action: 'kb.article.updated', targetType: 'kb_article', targetId: '3' } },
            'audit event',
        )
    })

    it('the request id comes with the request logger', () => {
        const lines: unknown[] = []
        const requestLog = {
            info: (obj: object, msg: string) => lines.push({ requestId: 'req-1', ...obj, msg }),
        }
        auditService.logCommitted(requestLog as never, [
            { action: 'auth.sessions.revoked_all', targetType: 'user', targetId: '4' },
        ])
        expect(lines).toEqual([
            {
                requestId: 'req-1',
                audit: { action: 'auth.sessions.revoked_all', targetType: 'user', targetId: '4' },
                msg: 'audit event',
            },
        ])
    })
})
