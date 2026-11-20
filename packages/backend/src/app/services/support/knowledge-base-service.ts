import { isServerRejection } from '#app/repositories/db-errors.js'
import { randomUUID } from 'node:crypto'
import type { UploadedFile } from '#vendor/types/types.js'
import appConfig from '#config/app.js'
import { supportKnowledgeRepository, withTransaction } from '#app/repositories/index.js'
import type { KbArticleRow, KbRow } from '#app/repositories/index.js'
import type { AuditActor } from '#app/services/audit/audit-actor.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import { contentFingerprint } from '#app/services/audit/content-fingerprint.js'
import { supportEmbeddingService } from '#app/services/support/support-embedding-service.js'
import { buildObjectKey, deleteFromS3, uploadToS3 } from '#vendor/utils/storage/s3.js'
import {
    detectImageType,
    IMAGE_EXTENSIONS,
    type DetectedImageType,
} from '#vendor/utils/storage/detect-image-type.js'
import logger from '#logger'
import { Result } from 'better-result'
import { badRequest, notFound, type AppResult } from '#app/services/shared/errors.js'
import { KB_SCREENSHOT_MAX_FILE_BYTES } from '#app/services/shared/upload-limits.js'

const ALLOWED_SCREENSHOT_TYPES: ReadonlySet<DetectedImageType> = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
])

// The declared multipart type must match the file's bytes (code-issues item 46).
function verifiedScreenshotType(file: UploadedFile): DetectedImageType | undefined {
    const detected = detectImageType(file.data)
    return detected !== undefined &&
        ALLOWED_SCREENSHOT_TYPES.has(detected) &&
        detected === file.type
        ? detected
        : undefined
}

type ArticleRow = NonNullable<Awaited<ReturnType<typeof supportKnowledgeRepository.findById>>>

// The article, or "not found": every operation on one article starts here.
async function requireArticle(id: bigint): Promise<AppResult<ArticleRow>> {
    const article = await supportKnowledgeRepository.findById(id)
    if (article === undefined) {
        return Result.err(notFound('Article', 'Article not found'))
    }
    return Result.ok(article)
}

// A screenshot that cannot be removed from S3 must not fail the operation that replaces or
// removes it: the object is left behind, and that is logged.
async function deleteScreenshotQuietly(key: string, message: string): Promise<void> {
    try {
        await deleteFromS3(key)
    } catch (err: unknown) {
        logger.warn({ err, key }, message)
    }
}

interface ArticleChange {
    title?: string
    content?: string
    category?: string | null
    isActive?: boolean
}

/** The fields of `data` whose value differs from the locked row (feat-235, Р5). */
function changedFields(row: KbArticleRow, data: ArticleChange): ArticleChange {
    const changed: ArticleChange = {}
    if (data.title !== undefined && data.title !== row.title) changed.title = data.title
    if (data.content !== undefined && data.content !== row.content) changed.content = data.content
    if (data.category !== undefined && data.category !== row.category) {
        changed.category = data.category
    }
    if (data.isActive !== undefined && data.isActive !== row.isActive) {
        changed.isActive = data.isActive
    }
    return changed
}

/**
 * Thrown by work inside a transaction before its COMMIT was sent (feat-235): the transaction is
 * known to have rolled back, unlike an error with no answer from the database.
 */
class RolledBackBeforeCommit extends Error {
    constructor(override readonly cause: unknown) {
        super('Rolled back before COMMIT')
        this.name = 'RolledBackBeforeCommit'
    }
}

const beforeCommit = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
        return await work()
    } catch (err: unknown) {
        throw new RolledBackBeforeCommit(err)
    }
}

export interface KbItemData {
    id: string
    title: string
    content: string
    category: string | null
    isActive: boolean
    hasScreenshot: boolean
    screenshotKey: string | null
    embeddingIndexed: boolean
    createdAt: string
    updatedAt: string
}

function rowToData(row: KbArticleRow | (KbRow & { embeddingIndexed: boolean })): KbItemData {
    return {
        id: String(row.id),
        title: row.title,
        content: row.content,
        category: row.category,
        isActive: row.isActive,
        hasScreenshot: row.screenshotKey !== null,
        screenshotKey: row.screenshotKey,
        embeddingIndexed: row.embeddingIndexed,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    }
}

export const knowledgeBaseService = {
    async getAll(opts: {
        category?: string
        page?: number
        limit?: number
    }): Promise<AppResult<{ items: KbItemData[]; total: number }>> {
        const limit = opts.limit ?? 50
        const offset = ((opts.page ?? 1) - 1) * limit
        const { rows, total } = await supportKnowledgeRepository.findAll({
            ...(opts.category !== undefined ? { category: opts.category } : {}),
            limit,
            offset,
        })

        return Result.ok({
            items: rows.map(rowToData),
            total,
        })
    },

    async getById(id: bigint): Promise<AppResult<{ item: KbItemData }>> {
        const result = await requireArticle(id)
        if (Result.isError(result)) {
            return Result.err(result.error)
        }

        return Result.ok({ item: rowToData(result.value) })
    },

    async create(
        data: {
            title: string
            content: string
            category?: string | null
            isActive?: boolean
        },
        actor: AuditActor,
    ): Promise<AppResult<{ item: KbItemData }>> {
        const { created, events } = await withTransaction(async (tx) => {
            const stamp = await auditService.stamp(tx)
            const row = await supportKnowledgeRepository.create(data, tx)
            const recorded = await auditService.record(tx, stamp, actor, [
                {
                    action: 'kb.article.created',
                    targetId: String(row.id),
                    input: { after: row, content: contentFingerprint(null, row.content) },
                },
            ])
            return { created: row, events: recorded }
        })
        auditService.logCommitted(actor.logger, events)

        void supportEmbeddingService.indexArticle(created).catch((err: unknown) => {
            logger.error({ err, articleId: String(created.id) }, 'Failed to index new KB article')
        })
        return Result.ok({
            item: rowToData({
                ...created,
                embeddingIndexed: false,
            }),
        })
    },

    /**
     * Applies the fields that differ from the stored article and records `kb.article.updated` in
     * the same transaction (feat-235): the row is locked first and is the "before". Nothing
     * changed: no UPDATE, no event, no new content version.
     */
    async update(
        id: bigint,
        data: ArticleChange,
        actor: AuditActor,
    ): Promise<AppResult<{ item: KbItemData }>> {
        // A quick 404 only: the "before" is the row locked below.
        const existingResult = await requireArticle(id)
        if (Result.isError(existingResult)) {
            return Result.err(existingResult.error)
        }

        const outcome = await withTransaction(
            async (
                tx,
            ): Promise<
                { item: KbItemData; events: RecordedAuditEvent[]; indexed?: KbRow } | undefined
            > => {
                const locked = await supportKnowledgeRepository.lockById(id, tx)
                if (locked === undefined) return undefined
                const changed = changedFields(locked, data)
                if (Object.keys(changed).length === 0) {
                    return { item: rowToData(locked), events: [] }
                }
                const stamp = await auditService.stamp(tx)
                const updated = await supportKnowledgeRepository.update(id, changed, tx)
                if (updated === undefined) throw new Error('Locked article row was not updated')
                const events = await auditService.record(tx, stamp, actor, [
                    {
                        action: 'kb.article.updated',
                        targetId: String(id),
                        input: {
                            before: locked,
                            after: updated,
                            content: contentFingerprint(locked.content, updated.content),
                        },
                    },
                ])
                const textChanged = changed.title !== undefined || changed.content !== undefined
                return {
                    item: rowToData({
                        ...updated,
                        // A text change cleared the vector in the same UPDATE (feat-114).
                        embeddingIndexed: updated.embedding !== null,
                    }),
                    events,
                    ...(textChanged ? { indexed: updated } : {}),
                }
            },
        )
        if (outcome === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }
        auditService.logCommitted(actor.logger, outcome.events)

        const reindex = outcome.indexed
        if (reindex !== undefined) {
            void supportEmbeddingService.indexArticle(reindex).catch((err: unknown) => {
                logger.error({ err, articleId: String(id) }, 'Failed to re-index KB article')
            })
        }
        return Result.ok({ item: outcome.item })
    },

    async delete(id: bigint, actor: AuditActor): Promise<AppResult<void>> {
        const outcome = await withTransaction(async (tx) => {
            const locked = await supportKnowledgeRepository.lockById(id, tx)
            if (locked === undefined) return undefined
            const stamp = await auditService.stamp(tx)
            // The key comes from the DELETE itself: a screenshot set meanwhile is the one removed.
            const deleted = await supportKnowledgeRepository.delete(id, tx)
            if (deleted === undefined) throw new Error('Locked article row was not deleted')
            const events = await auditService.record(tx, stamp, actor, [
                {
                    action: 'kb.article.deleted',
                    targetId: String(id),
                    input: { before: deleted, content: contentFingerprint(deleted.content, null) },
                },
            ])
            return { screenshotKey: deleted.screenshotKey, events }
        })
        if (outcome === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }
        auditService.logCommitted(actor.logger, outcome.events)
        if (outcome.screenshotKey !== null) {
            await deleteScreenshotQuietly(
                outcome.screenshotKey,
                'Failed to delete KB screenshot from S3',
            )
        }

        return Result.ok(undefined)
    },

    async uploadScreenshot(
        id: bigint,
        file: UploadedFile | undefined,
        actor: AuditActor,
    ): Promise<AppResult<{ item: KbItemData }>> {
        if (file === undefined) {
            return Result.err(badRequest('No file uploaded'))
        }
        if (file.data.byteLength > KB_SCREENSHOT_MAX_FILE_BYTES) {
            return Result.err(badRequest('File size exceeds 5 MB limit'))
        }
        const imageType = verifiedScreenshotType(file)
        if (imageType === undefined) {
            return Result.err(badRequest('Invalid file type. Allowed: png, jpeg, webp'))
        }

        const existingResult = await requireArticle(id)
        if (Result.isError(existingResult)) {
            return Result.err(existingResult.error)
        }
        const existing = existingResult.value

        // feat-116: upload the new object, swap the key in the row (which returns the key it
        // replaced), then delete that one. A failed upload leaves the article and its screenshot
        // as they were; a failed or refused swap takes the new object back.
        const s3Key = `knowledge-base/${String(id)}/${randomUUID()}.${IMAGE_EXTENSIONS[imageType]}`
        // Screenshots are public help content: the browser loads them from CDN_URL, the
        // only media origin allowed by the CSP img-src.
        await uploadToS3(s3Key, Buffer.from(file.data), imageType, { publicRead: true })

        let replaced:
            { previousKey: string | null; extra: RecordedAuditEvent[] | undefined } | undefined
        try {
            replaced = await supportKnowledgeRepository.replaceScreenshot(
                id,
                { key: s3Key, mime: imageType },
                (tx, previous) =>
                    // feat-235: the event commits with the swap. A throw here (the audit insert,
                    // the payload check) is before the COMMIT: a known rollback.
                    beforeCommit(async () => {
                        const stamp = await auditService.stamp(tx)
                        return auditService.record(tx, stamp, actor, [
                            {
                                action: 'kb.screenshot.uploaded',
                                targetId: String(id),
                                input: {
                                    hadScreenshot: previous.previousKey !== null,
                                    mime: imageType,
                                },
                            },
                        ])
                    }),
            )
        } catch (err: unknown) {
            // feat-130: the new object goes when the transaction is known to have rolled back:
            // PostgreSQL answered with an error, or our own work threw before the COMMIT was sent
            // (feat-235). Without an answer (a timeout, a dropped connection) the COMMIT may have
            // gone through and may not be visible to a re-read yet: the object stays (an orphan
            // beats a broken image).
            if (err instanceof RolledBackBeforeCommit || isServerRejection(err)) {
                await deleteScreenshotQuietly(s3Key, 'Failed to delete unused KB screenshot')
            } else {
                logger.warn(
                    { key: s3Key },
                    'KB screenshot swap failed without an answer from the database; new object kept',
                )
            }
            throw err instanceof RolledBackBeforeCommit ? err.cause : err
        }
        if (replaced === undefined) {
            await deleteScreenshotQuietly(s3Key, 'Failed to delete unused KB screenshot')
            return Result.err(notFound('Article', 'Article not found'))
        }
        auditService.logCommitted(actor.logger, replaced.extra ?? [])
        if (replaced.previousKey !== null) {
            await deleteScreenshotQuietly(
                replaced.previousKey,
                'Failed to delete old KB screenshot',
            )
        }

        return Result.ok({
            item: rowToData({
                ...existing,
                screenshotKey: s3Key,
                screenshotMime: imageType,
                updatedAt: new Date(),
                embeddingIndexed: existing.embeddingIndexed,
            }),
        })
    },

    async deleteScreenshot(
        id: bigint,
        actor: AuditActor,
    ): Promise<AppResult<{ item: KbItemData }>> {
        const existingResult = await requireArticle(id)
        if (Result.isError(existingResult)) {
            return Result.err(existingResult.error)
        }
        const existing = existingResult.value

        // The key to delete is the one the row held when it was cleared (feat-116), not the one
        // read above: an upload in between would otherwise leave its object behind.
        const replaced = await supportKnowledgeRepository.replaceScreenshot(
            id,
            null,
            async (tx, previous) => {
                // Nothing was removed: no event (feat-235).
                if (previous.previousKey === null) return []
                const stamp = await auditService.stamp(tx)
                return auditService.record(tx, stamp, actor, [
                    {
                        action: 'kb.screenshot.removed',
                        targetId: String(id),
                        input: { hadScreenshot: true, mime: previous.previousMime },
                    },
                ])
            },
        )
        if (replaced === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }
        auditService.logCommitted(actor.logger, replaced.extra ?? [])
        if (replaced.previousKey !== null) {
            await deleteScreenshotQuietly(
                replaced.previousKey,
                'Failed to delete KB screenshot from S3',
            )
        }

        return Result.ok({
            item: rowToData({
                ...existing,
                screenshotKey: null,
                screenshotMime: null,
                updatedAt: new Date(),
                embeddingIndexed: existing.embeddingIndexed,
            }),
        })
    },

    async getScreenshotKey(
        articleId: bigint,
        options: { activeOnly?: boolean } = {},
    ): Promise<AppResult<string | null>> {
        const article = await supportKnowledgeRepository.findById(articleId)
        if (article === undefined) return Result.ok(null)
        if (options.activeOnly === true && !article.isActive) return Result.ok(null)
        return Result.ok(article.screenshotKey ?? null)
    },

    /**
     * The screenshot a user may see. A deactivated article is out of the support chat, and so
     * is its screenshot (feat-160, decision Д3): it used to be served to anyone who asked by id.
     */
    async getScreenshotUrl(articleId: bigint): Promise<AppResult<{ url: string | null }>> {
        const screenshotKeyResult = await knowledgeBaseService.getScreenshotKey(articleId, {
            activeOnly: true,
        })
        if (Result.isError(screenshotKeyResult)) {
            return Result.err(screenshotKeyResult.error)
        }

        const screenshotKey = screenshotKeyResult.value
        if (screenshotKey === null) {
            return Result.ok({ url: null })
        }

        const cdnUrl = appConfig.cdnUrl.trim().replace(/\/+$/, '')
        if (cdnUrl.length === 0) {
            logger.warn(
                { articleId: String(articleId) },
                'CDN_URL is not set, cannot serve KB screenshot',
            )
            return Result.ok({ url: null })
        }

        return Result.ok({ url: `${cdnUrl}/${buildObjectKey(screenshotKey)}` })
    },

    async reindexArticle(id: bigint): Promise<AppResult<{ indexed: number }>> {
        const row = await supportKnowledgeRepository.findById(id)
        if (row === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }

        const stored = await supportEmbeddingService.indexArticle(row)

        // The article changed while it was indexed: the indexing of that change stores its vector.
        return Result.ok({ indexed: stored ? 1 : 0 })
    },

    async reindexAll(): Promise<AppResult<{ indexed: number; failed: string[] }>> {
        return Result.ok(await supportEmbeddingService.reindexAll())
    },
}
