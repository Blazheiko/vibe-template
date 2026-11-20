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

/**
 * Caches `row` unless the cache holds a newer revision of the same prompt (feat-235 review). Both
 * ways a row arrives go through here: the answer of a local edit and a reload from the database.
 * Edits of one prompt are applied in the order of its row lock, each raising `revision`, but
 * their answers (and a reload that already read a newer edit, made on another instance) can come
 * back in any order.
 */
function publish(row: PromptRow): boolean {
    const current = cache.get(row.type)
    if (current !== undefined && current.revision >= row.revision) return false
    cache.set(row.type, row)
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
        const rows = await promptRepository.findAll()
        // Row by row, by revision: a local edit that landed while this read was in flight is not
        // replaced by the older row it read.
        for (const row of rows) publish(row)
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
                { row: PromptRow; changed: boolean; events: RecordedAuditEvent[] } | undefined
            > => {
                const locked = await promptRepository.lockByType(type, tx)
                if (locked === undefined) return undefined
                const changed = changedFields(locked, data)
                // Nothing changed: no UPDATE, no event, and nothing to publish (the cache may
                // hold a newer row than this read by the time it returns).
                if (Object.keys(changed).length === 0)
                    return { row: locked, changed: false, events: [] }
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
                return { row: updated, changed: true, events }
            },
        )
        if (outcome === undefined) return false
        // The row the UPDATE returned is the cached one: no second read.
        if (outcome.changed) publish(outcome.row)
        auditService.logCommitted(actor.logger, outcome.events)
        return true
    },

    all(): PromptRow[] {
        return [...cache.values()]
    },
}
