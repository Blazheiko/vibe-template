import { randomUUID } from 'node:crypto'
import type { UploadedFile } from '#vendor/types/types.js'
import appConfig from '#config/app.js'
import { supportKnowledgeRepository } from '#app/repositories/index.js'
import type { KbArticleRow, KbRow } from '#app/repositories/index.js'
import { supportEmbeddingService } from '#app/services/support/support-embedding-service.js'
import { buildObjectKey, deleteFromS3, uploadToS3 } from '#vendor/utils/storage/s3.js'
import {
    detectImageType,
    IMAGE_EXTENSIONS,
    type DetectedImageType,
} from '#vendor/utils/storage/detect-image-type.js'
import logger from '#logger'
import { Result } from 'better-result'
import {
    badRequest,
    notFound,
    type AppResult,
    internalMessage,
} from '#app/services/shared/errors.js'
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

    async create(data: {
        title: string
        content: string
        category?: string | null
        isActive?: boolean
    }): Promise<AppResult<{ item: KbItemData }>> {
        const created = await supportKnowledgeRepository.create(data)

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

    async update(
        id: bigint,
        data: {
            title?: string
            content?: string
            category?: string | null
            isActive?: boolean
        },
    ): Promise<AppResult<{ item: KbItemData }>> {
        const existingResult = await requireArticle(id)
        if (Result.isError(existingResult)) {
            return Result.err(existingResult.error)
        }

        const updated = await supportKnowledgeRepository.update(id, data)

        if (updated === undefined) {
            return Result.err(internalMessage('Failed to update article'))
        }

        if (data.title !== undefined || data.content !== undefined) {
            void supportEmbeddingService.indexArticle(updated).catch((err: unknown) => {
                logger.error({ err, articleId: String(id) }, 'Failed to re-index KB article')
            })
        }
        return Result.ok({
            item: rowToData({
                ...updated,
                // A text change cleared the vector in the same UPDATE (feat-114).
                embeddingIndexed: updated.embedding !== null,
            }),
        })
    },

    async delete(id: bigint): Promise<AppResult<void>> {
        // The key comes from the DELETE itself: a screenshot set meanwhile is the one removed.
        const deleted = await supportKnowledgeRepository.delete(id)
        if (deleted === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }
        if (deleted.screenshotKey !== null) {
            await deleteScreenshotQuietly(
                deleted.screenshotKey,
                'Failed to delete KB screenshot from S3',
            )
        }

        return Result.ok(undefined)
    },

    async uploadScreenshot(
        id: bigint,
        file: UploadedFile | undefined,
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

        let replaced: { previousKey: string | null } | undefined
        try {
            replaced = await supportKnowledgeRepository.replaceScreenshot(id, {
                key: s3Key,
                mime: imageType,
            })
        } catch (err: unknown) {
            // feat-125: the swap may have committed although its answer was lost (a dropped
            // connection on COMMIT). The new object goes only when the row surely does not point
            // at it; when that cannot be told either, it stays (an orphan beats a broken image).
            const current = await supportKnowledgeRepository.findById(id).then(
                (row) => (row === undefined ? null : row.screenshotKey),
                () => s3Key,
            )
            if (current !== s3Key) {
                await deleteScreenshotQuietly(s3Key, 'Failed to delete unused KB screenshot')
            } else {
                logger.warn(
                    { key: s3Key },
                    'KB screenshot swap failed after the row took the new key; kept',
                )
            }
            throw err
        }
        if (replaced === undefined) {
            await deleteScreenshotQuietly(s3Key, 'Failed to delete unused KB screenshot')
            return Result.err(notFound('Article', 'Article not found'))
        }
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

    async deleteScreenshot(id: bigint): Promise<AppResult<{ item: KbItemData }>> {
        const existingResult = await requireArticle(id)
        if (Result.isError(existingResult)) {
            return Result.err(existingResult.error)
        }
        const existing = existingResult.value

        // The key to delete is the one the row held when it was cleared (feat-116), not the one
        // read above: an upload in between would otherwise leave its object behind.
        const replaced = await supportKnowledgeRepository.replaceScreenshot(id, null)
        if (replaced === undefined) {
            return Result.err(notFound('Article', 'Article not found'))
        }
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

    async getScreenshotKey(articleId: bigint): Promise<AppResult<string | null>> {
        const article = await supportKnowledgeRepository.findById(articleId)
        return Result.ok(article?.screenshotKey ?? null)
    },

    async getScreenshotUrl(articleId: bigint): Promise<AppResult<{ url: string | null }>> {
        const screenshotKeyResult = await knowledgeBaseService.getScreenshotKey(articleId)
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

    async reindexAll(): Promise<AppResult<{ indexed: number }>> {
        const indexed = await supportEmbeddingService.reindexAll()
        return Result.ok({ indexed })
    },
}
