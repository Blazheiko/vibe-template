import { db } from '#database/db.js'
import { supportKnowledgeBase } from '#database/schema.js'
import { and, asc, count, eq, sql } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

export type KbRow = InferSelectModel<typeof supportKnowledgeBase>
export interface KbArticleRow extends Omit<KbRow, 'embedding'> {
    embeddingIndexed: boolean
}

export interface KbSearchResult {
    id: bigint
    title: string
    content: string
    screenshotKey: string | null
    screenshotMime: string | null
    distance: number
}

export interface KbListOptions {
    category?: string
    limit?: number
    offset?: number
}

const kbArticleSelect = {
    id: supportKnowledgeBase.id,
    title: supportKnowledgeBase.title,
    content: supportKnowledgeBase.content,
    category: supportKnowledgeBase.category,
    screenshotKey: supportKnowledgeBase.screenshotKey,
    screenshotMime: supportKnowledgeBase.screenshotMime,
    contentVersion: supportKnowledgeBase.contentVersion,
    isActive: supportKnowledgeBase.isActive,
    createdAt: supportKnowledgeBase.createdAt,
    updatedAt: supportKnowledgeBase.updatedAt,
    embeddingIndexed: sql<boolean>`embedding IS NOT NULL`,
}

const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`

export const supportKnowledgeRepository = {
    async findAll(opts: KbListOptions = {}): Promise<{ rows: KbArticleRow[]; total: number }> {
        const { category, limit = 50, offset = 0 } = opts
        const whereClause =
            category !== undefined && category !== ''
                ? eq(supportKnowledgeBase.category, category)
                : undefined

        const baseQuery = db.select(kbArticleSelect).from(supportKnowledgeBase)
        // Ordered: LIMIT/OFFSET without an order pages over whatever order the table happens
        // to be read in, and an edited row can move between pages (feat-160).
        const [rows, totalResult] = await Promise.all([
            whereClause !== undefined
                ? baseQuery
                      .where(whereClause)
                      .orderBy(asc(supportKnowledgeBase.id))
                      .limit(limit)
                      .offset(offset)
                : baseQuery.orderBy(asc(supportKnowledgeBase.id)).limit(limit).offset(offset),
            whereClause !== undefined
                ? db.select({ count: count() }).from(supportKnowledgeBase).where(whereClause)
                : db.select({ count: count() }).from(supportKnowledgeBase),
        ])

        const total = totalResult[0]?.count ?? 0
        return { rows, total }
    },

    async findById(id: bigint): Promise<KbArticleRow | undefined> {
        const rows = await db
            .select(kbArticleSelect)
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
            .limit(1)
        return rows[0]
    },

    async findActiveAll(): Promise<KbRow[]> {
        return db.select().from(supportKnowledgeBase).where(eq(supportKnowledgeBase.isActive, true))
    },

    async create(data: {
        title: string
        content: string
        category?: string | null
        isActive?: boolean
    }): Promise<KbRow> {
        const [created] = await db
            .insert(supportKnowledgeBase)
            .values({
                title: data.title,
                content: data.content,
                category: data.category ?? null,
                isActive: data.isActive ?? true,
            })
            .returning()
        if (created === undefined) {
            throw new Error('Failed to create knowledge base article')
        }
        return created
    },

    /**
     * Inserts every article in one statement (feat-125): the knowledge-base import is all or
     * nothing, so a run that stops halfway leaves no partial base behind.
     */
    async createMany(
        articles: readonly { title: string; content: string; category: string | null }[],
    ): Promise<KbRow[]> {
        if (articles.length === 0) return []
        return db
            .insert(supportKnowledgeBase)
            .values(articles.map((article) => ({ ...article, isActive: true })))
            .returning()
    },

    async update(
        id: bigint,
        data: {
            title?: string
            content?: string
            category?: string | null
            isActive?: boolean
        },
    ): Promise<KbRow | undefined> {
        // feat-114 (R11b): a new text is a new version, and the vector of the old text is not
        // searchable from this statement on (not after the re-index, which may never finish).
        const textChanged = data.title !== undefined || data.content !== undefined
        const [updated] = await db
            .update(supportKnowledgeBase)
            .set({
                ...data,
                ...(textChanged
                    ? {
                          contentVersion: sql`${supportKnowledgeBase.contentVersion} + 1`,
                          embedding: null,
                      }
                    : {}),
                updatedAt: new Date(),
            })
            .where(eq(supportKnowledgeBase.id, id))
            .returning()
        return updated
    },

    /**
     * Deletes the article and returns its screenshot key from the same statement, so a screenshot
     * set meanwhile is the one deleted from S3 (feat-116). Undefined when there was no article.
     */
    async delete(id: bigint): Promise<{ screenshotKey: string | null } | undefined> {
        const [deleted] = await db
            .delete(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
            .returning({ screenshotKey: supportKnowledgeBase.screenshotKey })
        return deleted
    },

    /**
     * Sets the screenshot (or clears it with null) and returns the key it replaced, read from the
     * row locked in the same transaction (feat-116): of two concurrent changes each gets the key
     * the other set, so every replaced object is deleted exactly once. Undefined when the article
     * is gone. The content version stays: a screenshot is not part of the indexed text.
     */
    async replaceScreenshot(
        id: bigint,
        screenshot: { key: string; mime: string } | null,
    ): Promise<{ previousKey: string | null } | undefined> {
        return db.transaction(async (tx) => {
            const [current] = await tx
                .select({ screenshotKey: supportKnowledgeBase.screenshotKey })
                .from(supportKnowledgeBase)
                .where(eq(supportKnowledgeBase.id, id))
                .for('update')
            if (current === undefined) return undefined
            await tx
                .update(supportKnowledgeBase)
                .set({
                    screenshotKey: screenshot?.key ?? null,
                    screenshotMime: screenshot?.mime ?? null,
                    updatedAt: new Date(),
                })
                .where(eq(supportKnowledgeBase.id, id))
            return { previousKey: current.screenshotKey }
        })
    },

    /**
     * Stores the vector made from the text of `contentVersion`, only while the article still has
     * that version (feat-114): an indexing that read an older text and finishes last writes
     * nothing. A screenshot change does not move the version.
     *
     * @returns whether the vector was stored
     */
    async setEmbedding(id: bigint, vector: number[], contentVersion: number): Promise<boolean> {
        const stored = await db
            .update(supportKnowledgeBase)
            .set({ embedding: toVectorLiteral(vector) })
            .where(
                and(
                    eq(supportKnowledgeBase.id, id),
                    eq(supportKnowledgeBase.contentVersion, contentVersion),
                ),
            )
            .returning({ id: supportKnowledgeBase.id })
        return stored.length > 0
    },

    // One statement, so the vector and updatedAt change together or not at all.
    async clearEmbedding(id: bigint): Promise<void> {
        await db
            .update(supportKnowledgeBase)
            .set({ embedding: null, updatedAt: new Date() })
            .where(eq(supportKnowledgeBase.id, id))
    },

    // maxDistance: cosine distance (<=>) above which an article is not relevant.
    async searchByEmbedding(
        queryVector: number[],
        limit: number,
        maxDistance?: number,
    ): Promise<KbSearchResult[]> {
        const kb = supportKnowledgeBase
        const result = await db.execute<{
            id: bigint | string
            title: string
            content: string
            screenshot_key: string | null
            screenshot_mime: string | null
            distance: number | string
        }>(
            sql`
                SELECT ${kb.id} AS id, ${kb.title} AS title, ${kb.content} AS content,
                       ${kb.screenshotKey} AS screenshot_key, ${kb.screenshotMime} AS screenshot_mime,
                       ${kb.embedding} <=> ${toVectorLiteral(queryVector)}::vector AS distance
                FROM ${kb}
                WHERE ${kb.isActive} = true
                  AND ${kb.embedding} IS NOT NULL
                  ${maxDistance !== undefined ? sql`AND ${kb.embedding} <=> ${toVectorLiteral(queryVector)}::vector <= ${maxDistance}` : sql``}
                ORDER BY distance ASC
                LIMIT ${limit}
            `,
        )

        return result.rows.map((row) => ({
            id: typeof row.id === 'string' ? BigInt(row.id) : row.id,
            title: row.title,
            content: row.content,
            screenshotKey: row.screenshot_key,
            screenshotMime: row.screenshot_mime,
            distance: typeof row.distance === 'string' ? parseFloat(row.distance) : row.distance,
        }))
    },
}
