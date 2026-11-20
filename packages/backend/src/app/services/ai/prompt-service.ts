import { promptRepository, withTransaction } from '#app/repositories/index.js'
import type { PromptRow, PromptType, PromptUpdate } from '#app/repositories/index.js'
import logger from '#logger'
import aiConfig from '#config/ai.js'
import type { AuditActor } from '#app/services/audit/audit-actor.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import { contentFingerprint } from '#app/services/audit/content-fingerprint.js'

export type { PromptType, PromptUpdate }

const cache = new Map<PromptType, PromptRow>()
let loadedAt = 0
let refreshing: Promise<void> | null = null
// update() bumps writeSeq: a load() that started before a local update must not
// overwrite the fresh row with the one it read earlier.
let writeSeq = 0
const writtenAt = new Map<PromptType, number>()
// feat-235 (review): the audit stamp of the change each cached row came from. Edits of one prompt
// commit in the order of its row lock, but their answers can come back here in another order; the
// row of an older change must not replace the row of a newer one.
const appliedStamp = new Map<PromptType, string>()

/** `clock_timestamp()::text` with the fraction padded, so two stamps compare as strings. */
const comparableStamp = (stamp: string): string => {
    const [whole = '', fraction = ''] = stamp.split('.')
    return `${whole}.${fraction.padEnd(6, '0')}`
}

/** Caches the row of a change unless a newer change of the same prompt is cached already. */
function publish(type: PromptType, row: PromptRow, stamp: string): boolean {
    const current = appliedStamp.get(type)
    if (current !== undefined && comparableStamp(current) >= comparableStamp(stamp)) return false
    appliedStamp.set(type, stamp)
    cache.set(type, row)
    writeSeq++
    writtenAt.set(type, writeSeq)
    return true
}

// Reads stay synchronous: a stale cache answers with what it has and refreshes in
// the background, so another instance's update shows up within PROMPT_CACHE_TTL_MS
// (code-issues item 43). One refresh at a time; a failed one keeps the old values.
function cached(type: PromptType): PromptRow | undefined {
    if (refreshing === null && Date.now() - loadedAt >= aiConfig.promptCacheTtlMs) {
        refreshing = promptService
            .load()
            .catch((err: unknown) => {
                logger.warn({ err }, 'PromptService: refresh failed, keeping cached prompts')
            })
            .finally(() => {
                refreshing = null
            })
    }
    return cache.get(type)
}

// `temperature` is a `real`: compared as the float32 it is stored as, so sending back the value
// that was read is not a change.
const sameTemperature = (a: number | null, b: number | null): boolean =>
    a === null || b === null ? a === b : Math.fround(a) === Math.fround(b)

/** The fields of `data` whose value differs from the locked row (feat-235, Р5). */
function changedFields(row: PromptRow, data: PromptUpdate): PromptUpdate {
    const changed: PromptUpdate = {}
    if (data.content !== undefined && data.content !== row.content) changed.content = data.content
    if (data.model !== undefined && data.model !== row.model) changed.model = data.model
    if (data.temperature !== undefined && !sameTemperature(data.temperature, row.temperature)) {
        changed.temperature = data.temperature
    }
    if (data.maxTokens !== undefined && data.maxTokens !== row.maxTokens) {
        changed.maxTokens = data.maxTokens
    }
    return changed
}

export const promptService = {
    async load(): Promise<void> {
        const startSeq = writeSeq
        const rows = await promptRepository.findAll()
        const next = new Map<PromptType, PromptRow>()
        for (const row of rows) {
            next.set(row.type, row)
        }
        for (const [type, seq] of writtenAt) {
            const fresh = cache.get(type)
            if (seq > startSeq && fresh !== undefined) next.set(type, fresh)
        }
        cache.clear()
        for (const [type, row] of next) {
            cache.set(type, row)
        }
        loadedAt = Date.now()
        logger.info(`PromptService: loaded ${String(rows.length)} prompts`)
    },

    get(type: PromptType): PromptRow | undefined {
        return cached(type)
    },

    getContent(type: PromptType): string {
        return cached(type)?.content ?? ''
    },

    getModel(type: PromptType): string | null {
        return cached(type)?.model ?? null
    },

    getTemperature(type: PromptType): number | null {
        return cached(type)?.temperature ?? null
    },

    getMaxTokens(type: PromptType): number | null {
        return cached(type)?.maxTokens ?? null
    },

    /**
     * Applies the fields that differ from the stored prompt and records `ai.prompt.updated` in the
     * same transaction (feat-235): the row is locked first, so of two edits the second sees the
     * first as its "before". Nothing changed: no UPDATE and no event. False when there is no
     * such prompt.
     */
    async update(type: PromptType, data: PromptUpdate, actor: AuditActor): Promise<boolean> {
        const outcome = await withTransaction(
            async (
                tx,
            ): Promise<
                { row: PromptRow; stamp: string | null; events: RecordedAuditEvent[] } | undefined
            > => {
                const locked = await promptRepository.lockByType(type, tx)
                if (locked === undefined) return undefined
                const changed = changedFields(locked, data)
                // Nothing changed: no UPDATE, no event, and nothing to publish (the cache may
                // hold a newer row than this read by the time it returns).
                if (Object.keys(changed).length === 0)
                    return { row: locked, stamp: null, events: [] }
                const stamp = await auditService.stamp(tx)
                const updated = await promptRepository.update(type, changed, tx)
                if (updated === undefined) throw new Error('Locked prompt row was not updated')
                const events = await auditService.record(tx, stamp, actor, [
                    {
                        action: 'ai.prompt.updated',
                        targetId: type,
                        input: {
                            before: locked,
                            after: updated,
                            content: contentFingerprint(locked.content, updated.content),
                        },
                    },
                ])
                return { row: updated, stamp: stamp.occurredAt, events }
            },
        )
        if (outcome === undefined) return false
        // The row the UPDATE returned is the cached one: no second read.
        if (outcome.stamp !== null) publish(type, outcome.row, outcome.stamp)
        auditService.logCommitted(actor.logger, outcome.events)
        return true
    },

    all(): PromptRow[] {
        return [...cache.values()]
    },
}
