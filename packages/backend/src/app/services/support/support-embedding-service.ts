import { openaiEmbeddingAdapter } from '#app/services/ai/adapters/openai-embedding-adapter.js'
import { supportKnowledgeRepository } from '#app/repositories/index.js'
import type { KbSearchResult } from '#app/repositories/index.js'
import { llmUsageService } from '#app/services/ai/usage/llm-usage-service.js'
import type { TokenUsage } from '#app/services/ai/types.js'
import logger from '#logger'
import supportConfig from '#config/support.js'

// The version read with the text goes with its vector: a newer text in the meantime wins.
async function storeVector(
    article: { id: bigint; contentVersion: number },
    vector: number[],
): Promise<boolean> {
    const stored = await supportKnowledgeRepository.setEmbedding(
        article.id,
        vector,
        article.contentVersion,
    )
    if (!stored) {
        logger.info(
            { articleId: String(article.id), contentVersion: article.contentVersion },
            'KB article changed while it was indexed: the vector of the old text is dropped',
        )
    }
    return stored
}

export const supportEmbeddingService = {
    /**
     * Embeds the text of one version of an article and stores the vector if the article still has
     * that version (feat-114).
     *
     * @returns whether the vector was stored; false when not configured or the text has changed since
     */
    async indexArticle(
        article: {
            id: bigint
            title: string
            content: string
            contentVersion: number
        },
        options: {
            /**
             * Stops the indexing (feat-119, F3): it cancels the provider call, and is checked again
             * right before the vector is written, so a holder that lost its lease during the
             * provider wait writes nothing.
             */
            signal?: AbortSignal
        } = {},
    ): Promise<boolean> {
        if (!openaiEmbeddingAdapter.isConfigured()) {
            logger.warn('OpenAI Embedding not configured, skipping indexing')
            return false
        }
        const text = `${article.title}\n\n${article.content}`
        // Indexing is a system call: no user to attribute it to.
        const vector = await openaiEmbeddingAdapter.embed(text, {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            onComplete: llmUsageService.textUsageRecorder('SUPPORT_EMBEDDING', null),
        })
        options.signal?.throwIfAborted()
        return storeVector(article, vector)
    },

    /**
     * Indexes every active article. A batch the provider refuses (one article longer than the
     * model's input, a 5xx) does not stop the run: its articles are reported in `failed` and the
     * later batches are still indexed (feat-160). It used to throw out of the loop, so one
     * article kept every article after it unindexed, run after run.
     */
    async reindexAll(): Promise<{ indexed: number; failed: string[] }> {
        if (!openaiEmbeddingAdapter.isConfigured()) {
            logger.warn('OpenAI Embedding not configured, skipping reindex')
            return { indexed: 0, failed: [] }
        }

        const allRows = await supportKnowledgeRepository.findActiveAll()
        if (allRows.length === 0) return { indexed: 0, failed: [] }

        // In batches of SUPPORT_EMBEDDING_BATCH_SIZE (code-issues item 54): one huge
        // request could exceed the provider's input limits.
        const batchSize = supportConfig.embeddingBatchSize
        let stored = 0
        const failed: string[] = []
        for (let start = 0; start < allRows.length; start += batchSize) {
            const batch = allRows.slice(start, start + batchSize)
            let vectors: number[][]
            try {
                vectors = await openaiEmbeddingAdapter.embedBatch(
                    batch.map((a) => `${a.title}\n\n${a.content}`),
                    { onComplete: llmUsageService.textUsageRecorder('SUPPORT_EMBEDDING', null) },
                )
            } catch (err) {
                const articleIds = batch.map((a) => String(a.id))
                logger.error(
                    { err, articleIds },
                    'Support KB reindex: a batch was not embedded, the run goes on',
                )
                failed.push(...articleIds)
                continue
            }
            for (let i = 0; i < batch.length; i++) {
                const article = batch[i]
                const vector = vectors[i]
                if (article === undefined || vector === undefined) continue
                if (await storeVector(article, vector)) stored += 1
            }
        }

        // feat-119 (F5): the vectors written, not the rows read: an article edited meanwhile is
        // indexed by the indexing of its edit, not by this run.
        return { indexed: stored, failed }
    },

    /** Whether `search` will call the provider (it answers nothing without one). */
    isConfigured(): boolean {
        return openaiEmbeddingAdapter.isConfigured()
    },

    async search(
        query: string,
        limit = 5,
        options: {
            userId?: bigint
            signal?: AbortSignal
            /** Receives the usage the provider reported (the daily budget settles with it). */
            onUsage?: (usage: TokenUsage) => void
        } = {},
    ): Promise<KbSearchResult[]> {
        if (!openaiEmbeddingAdapter.isConfigured()) {
            logger.warn('OpenAI Embedding not configured, returning empty results')
            return []
        }
        const queryVector = await openaiEmbeddingAdapter.embed(query, {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            onComplete: llmUsageService.textUsageRecorder(
                'SUPPORT_EMBEDDING',
                options.userId ?? null,
                null,
                options.onUsage,
            ),
        })
        return supportKnowledgeRepository.searchByEmbedding(
            queryVector,
            limit,
            supportConfig.searchMaxDistance,
        )
    },
}
