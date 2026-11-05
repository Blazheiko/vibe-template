import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openaiEmbeddingAdapter } from '#app/services/ai/adapters/openai-embedding-adapter.js'
import { supportKnowledgeRepository } from '#app/repositories/index.js'
import { supportEmbeddingService } from '#app/services/support/support-embedding-service.js'
import { acquireLease, type HeldLease, type Lease } from '#app/services/shared/redis-lease.js'
import logger from '#logger'

const INIT_DELAY_MS = 100

// feat-115 (R11c): one import at a time across every instance. The in-memory state answers only
// for this process; the Redis lease (redis-lease.ts) admits one instance. A run that cannot renew
// it stops before its next write, so two instances never both write articles.
export const KB_INIT_LOCK_KEY = 'support:kb-init'
const KB_INIT_LEASE: Lease = { ttlMs: 30_000, renewEveryMs: 10_000, maxLifetimeMs: 60 * 60_000 }

export class KnowledgeBaseInitLockLostError extends Error {
    override readonly name = 'KnowledgeBaseInitLockLostError'

    constructor(reason: string) {
        super(`lock lost: ${reason}`)
    }
}

export type KnowledgeBaseInitStartErrorCode =
    'ALREADY_RUNNING' | 'EMBEDDINGS_NOT_CONFIGURED' | 'NOT_EMPTY'

export interface KnowledgeBaseInitStatus {
    state: 'idle' | 'running' | 'completed' | 'failed'
    totalFiles: number
    processedFiles: number
    createdArticles: number
    failedFiles: number
    progressPercent: number
    currentFile: string | null
    startedAt: string | null
    completedAt: string | null
    message: string | null
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

function parseArticleFile(raw: string, filename: string): { title: string; content: string } {
    const normalized = raw.replace(/\r\n/g, '\n').trim()
    const lines = normalized.split('\n')
    const title = lines.find((line) => line.trim().length > 0)?.trim() ?? basename(filename, '.txt')
    const titleIndex = lines.findIndex((line) => line.trim() === title)
    const content = lines
        .slice(titleIndex >= 0 ? titleIndex + 1 : 0)
        .join('\n')
        .trim()

    return {
        title,
        content: content.length > 0 ? content : normalized,
    }
}

function inferCategory(filename: string): string | null {
    const lower = filename.toLowerCase()
    if (lower.includes('support')) return 'support'
    if (lower.includes('admin')) return 'admin'
    if (lower.includes('account')) return 'account'
    if (lower.includes('login') || lower.includes('navigation')) return 'getting-started'
    if (lower.includes('chat')) return 'support'
    return null
}

async function resolveKnowledgeBaseDir(): Promise<string> {
    const candidates = [
        join(process.cwd(), 'docs', 'support-knowledge-base'),
        fileURLToPath(new URL('../../../../../docs/support-knowledge-base/', import.meta.url)),
    ]

    for (const candidate of candidates) {
        try {
            await access(candidate)
            return candidate
        } catch {
            continue
        }
    }

    throw new Error('Knowledge base source directory not found')
}

export interface KnowledgeBaseInitOptions {
    lease?: Lease
    /** Where the article files are; tests give their own. */
    resolveSourceDir?: () => Promise<string>
    delayMs?: number
}

export type KnowledgeBaseInitStartResult =
    | { ok: true; status: KnowledgeBaseInitStatus }
    | {
          ok: false
          status: KnowledgeBaseInitStatus
          message: string
          errorCode: KnowledgeBaseInitStartErrorCode
      }

export interface KnowledgeBaseInitService {
    getStatus(): KnowledgeBaseInitStatus
    start(): Promise<KnowledgeBaseInitStartResult>
    /** The import started by the last successful start(); tests wait for it. */
    readonly running: Promise<void> | null
}

const idleStatus = (): KnowledgeBaseInitStatus => ({
    state: 'idle',
    totalFiles: 0,
    processedFiles: 0,
    createdArticles: 0,
    failedFiles: 0,
    progressPercent: 0,
    currentFile: null,
    startedAt: null,
    completedAt: null,
    message: null,
})

/** One per process; tests create two to stand for two instances. */
export function createKnowledgeBaseInitService({
    lease = KB_INIT_LEASE,
    resolveSourceDir = resolveKnowledgeBaseDir,
    delayMs = INIT_DELAY_MS,
}: KnowledgeBaseInitOptions = {}): KnowledgeBaseInitService {
    const status = idleStatus()
    let running: Promise<void> | null = null

    const cloneStatus = (): KnowledgeBaseInitStatus => ({ ...status })

    const setProgress = (): void => {
        status.progressPercent =
            status.totalFiles === 0
                ? 0
                : Math.min(100, Math.round((status.processedFiles / status.totalFiles) * 100))
    }

    const finish = (state: 'completed' | 'failed', message: string): void => {
        status.state = state
        status.currentFile = null
        status.completedAt = new Date().toISOString()
        status.message = message
    }

    // Checked before every write: a run that lost the lease writes nothing more.
    const ensureHeld = (lock: HeldLease): void => {
        if (lock.lost.aborted) throw lock.lost.reason
    }

    async function runInit(lock: HeldLease): Promise<void> {
        try {
            const knowledgeBaseDir = await resolveSourceDir()
            const files = (await readdir(knowledgeBaseDir))
                .filter((name) => name.endsWith('.txt') && name !== 'README.txt')
                .sort((a, b) => a.localeCompare(b))

            status.totalFiles = files.length
            setProgress()

            // feat-125: read every file first, then insert every article in ONE statement, then
            // index. A run that loses its lease (or fails) before the insert leaves nothing; after
            // it the base is complete and only vectors may be missing, which reindex-all adds.
            // Before, the articles went in one by one between the provider calls, and a run
            // stopped halfway left a partial base that refused every later init (NOT_EMPTY).
            const articles: { title: string; content: string; category: string | null }[] = []
            for (const filename of files) {
                status.currentFile = filename
                try {
                    const raw = await readFile(join(knowledgeBaseDir, filename), 'utf8')
                    articles.push({
                        ...parseArticleFile(raw, filename),
                        category: inferCategory(filename),
                    })
                } catch (err) {
                    status.failedFiles += 1
                    status.processedFiles += 1
                    setProgress()
                    logger.error({ err, filename }, 'Knowledge base init: failed to read article')
                }
            }

            ensureHeld(lock)
            const created = await supportKnowledgeRepository.createMany(articles)
            status.createdArticles = created.length

            for (let index = 0; index < created.length; index++) {
                const article = created[index]
                if (article === undefined) continue
                status.currentFile = article.title
                ensureHeld(lock)
                try {
                    // feat-119 (F3): the lease is checked again right before the vector write,
                    // after the provider wait, and its loss cancels that wait.
                    await supportEmbeddingService.indexArticle(article, { signal: lock.lost })
                } catch (err) {
                    // The provider may wrap the abort in its own error: the signal decides.
                    if (lock.lost.aborted) throw lock.lost.reason
                    if (err instanceof KnowledgeBaseInitLockLostError) throw err
                    status.failedFiles += 1
                    logger.error(
                        { err, articleId: String(article.id) },
                        'Knowledge base init: failed to index article',
                    )
                }
                status.processedFiles += 1
                setProgress()

                if (index < created.length - 1) {
                    await delay(delayMs)
                }
            }

            if (status.failedFiles > 0) {
                finish('failed', `Completed with ${String(status.failedFiles)} failed file(s).`)
            } else {
                finish('completed', `Imported ${String(status.createdArticles)} article(s).`)
            }
        } catch (err) {
            if (err instanceof KnowledgeBaseInitLockLostError) {
                logger.error({ err }, 'Knowledge base init: stopped, the lock was lost')
                const indexing =
                    status.createdArticles > 0
                        ? ` ${String(status.createdArticles)} article(s) imported; run reindex-all for the missing vectors.`
                        : ''
                finish(
                    'failed',
                    `Knowledge base initialization stopped: ${err.message}.${indexing}`,
                )
                return
            }
            logger.error({ err }, 'Knowledge base init: unexpected failure')
            finish(
                'failed',
                err instanceof Error ? err.message : 'Knowledge base initialization failed',
            )
        } finally {
            // After a lost lease the key may be another instance's: release is then a no-op.
            await lock.release().catch((err: unknown) => {
                logger.warn({ err }, 'Knowledge base init: lock release failed')
            })
        }
    }

    // An early exit of start() puts back the state it had before.
    const restore = (previous: KnowledgeBaseInitStatus): void => {
        Object.assign(status, previous)
    }
    const refuse = (
        previous: KnowledgeBaseInitStatus,
        errorCode: KnowledgeBaseInitStartErrorCode,
        message: string,
    ): KnowledgeBaseInitStartResult => {
        restore(previous)
        return { ok: false, status: cloneStatus(), message, errorCode }
    }

    return {
        getStatus: cloneStatus,

        get running(): Promise<void> | null {
            return running
        },

        async start(): Promise<KnowledgeBaseInitStartResult> {
            if (status.state === 'running') {
                return {
                    ok: false,
                    status: cloneStatus(),
                    message: 'Knowledge base initialization is already running',
                    errorCode: 'ALREADY_RUNNING',
                }
            }
            // Before the first await, so a second start() in this process is refused.
            const previous = cloneStatus()
            status.state = 'running'

            if (!openaiEmbeddingAdapter.isConfigured()) {
                return refuse(
                    previous,
                    'EMBEDDINGS_NOT_CONFIGURED',
                    'OpenAI embeddings are not configured',
                )
            }

            let lock: HeldLease | null
            try {
                lock = await acquireLease(
                    KB_INIT_LOCK_KEY,
                    lease,
                    (reason) => new KnowledgeBaseInitLockLostError(reason),
                )
            } catch (err) {
                restore(previous)
                throw err
            }
            if (lock === null) {
                // Another instance is importing.
                return refuse(
                    previous,
                    'ALREADY_RUNNING',
                    'Knowledge base initialization is already running',
                )
            }

            try {
                // Under the lock, so an import another instance has just finished counts.
                const existing = await supportKnowledgeRepository.findAll({ limit: 1, offset: 0 })
                if (existing.total > 0) {
                    await lock.release()
                    return refuse(previous, 'NOT_EMPTY', 'Knowledge base is not empty')
                }
            } catch (err) {
                await lock.release().catch(() => undefined)
                restore(previous)
                throw err
            }

            Object.assign(status, idleStatus(), {
                state: 'running',
                startedAt: new Date().toISOString(),
            })
            running = runInit(lock)

            return { ok: true, status: cloneStatus() }
        },
    }
}

export const knowledgeBaseInitService = createKnowledgeBaseInitService()
