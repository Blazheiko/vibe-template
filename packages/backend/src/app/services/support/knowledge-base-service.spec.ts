import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { JPEG_BYTES, PNG_BYTES } from '../../../test-support/image-fixtures.js'

const supportKnowledgeRepositoryMock = {
    findAll: vi.fn(),
    findById: vi.fn(),
    findActiveAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setScreenshot: vi.fn(),
    clearScreenshot: vi.fn(),
    setEmbedding: vi.fn(),
    clearEmbedding: vi.fn(),
}

const supportEmbeddingServiceMock = {
    indexArticle: vi.fn(() => Promise.resolve(undefined)),
    reindexAll: vi.fn(),
    search: vi.fn(),
}

const loggerMock = {
    error: vi.fn(),
    warn: vi.fn(),
}

const uploadToS3Mock = vi.fn(() => Promise.resolve(undefined))
const appConfigMock = { cdnUrl: 'https://cdn.test/' }

vi.mock('#app/repositories/support/support-knowledge-repository.js', () => ({
    supportKnowledgeRepository: supportKnowledgeRepositoryMock,
}))

vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: supportEmbeddingServiceMock,
}))

vi.mock('#logger', () => ({
    default: loggerMock,
}))

vi.mock('#vendor/utils/storage/s3.js', () => ({
    buildObjectKey: (key: string) => `app/uploads/${key}`,
    uploadToS3: uploadToS3Mock,
    deleteFromS3: vi.fn(() => Promise.resolve(undefined)),
}))

vi.mock('#config/app.js', () => ({
    default: appConfigMock,
}))

async function loadKnowledgeBaseService() {
    return import('./knowledge-base-service.js')
}

afterEach(() => {
    appConfigMock.cdnUrl = 'https://cdn.test/'
    vi.resetModules()
    vi.clearAllMocks()
})

describe('knowledgeBaseService', () => {
    it('returns mapped articles for getAll', async () => {
        supportKnowledgeRepositoryMock.findAll.mockResolvedValue({
            rows: [
                {
                    id: 1n,
                    title: 'Article 1',
                    content: 'Content 1',
                    category: 'support',
                    isActive: true,
                    screenshotKey: null,
                    embeddingIndexed: false,
                    createdAt: new Date('2026-05-08T10:00:00.000Z'),
                    updatedAt: new Date('2026-05-08T11:00:00.000Z'),
                },
            ],
            total: 1,
        })

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.getAll({ page: 1, limit: 10 })

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                items: [
                    {
                        id: '1',
                        title: 'Article 1',
                        content: 'Content 1',
                        category: 'support',
                        isActive: true,
                        hasScreenshot: false,
                        screenshotKey: null,
                        embeddingIndexed: false,
                        createdAt: '2026-05-08T10:00:00.000Z',
                        updatedAt: '2026-05-08T11:00:00.000Z',
                    },
                ],
                total: 1,
            })
        }
    })

    // ADR 0004: a repository failure is not an AppError; it reaches the transport (500).
    it('lets a getAll repository failure propagate', async () => {
        const dbError = new Error('db down')
        supportKnowledgeRepositoryMock.findAll.mockRejectedValue(dbError)

        const { knowledgeBaseService } = await loadKnowledgeBaseService()

        await expect(knowledgeBaseService.getAll({})).rejects.toBe(dbError)
    })

    it('returns not found for missing article', async () => {
        supportKnowledgeRepositoryMock.findById.mockResolvedValue(undefined)

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.getById(11n)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'Article',
                message: 'Article not found',
            })
        }
    })

    it('creates an article and triggers indexing', async () => {
        supportKnowledgeRepositoryMock.create.mockResolvedValue({
            id: 5n,
            title: 'New Article',
            content: 'Body',
            category: 'support',
            isActive: true,
            screenshotKey: null,
            embeddingIndexed: false,
            createdAt: new Date('2026-05-08T10:00:00.000Z'),
            updatedAt: new Date('2026-05-08T10:00:00.000Z'),
        })
        supportKnowledgeRepositoryMock.findById.mockResolvedValue({
            id: 5n,
            title: 'New Article',
            content: 'Body',
            category: 'support',
            isActive: true,
            screenshotKey: null,
            embeddingIndexed: true,
            createdAt: new Date('2026-05-08T10:00:00.000Z'),
            updatedAt: new Date('2026-05-08T10:00:00.000Z'),
        })

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.create({
            title: 'New Article',
            content: 'Body',
            category: 'support',
            isActive: true,
        })

        expect(Result.isOk(result)).toBe(true)
        expect(supportEmbeddingServiceMock.indexArticle).toHaveBeenCalledWith(
            5n,
            'New Article',
            'Body',
        )
        if (Result.isOk(result)) {
            expect(result.value.item).toMatchObject({
                id: '5',
                title: 'New Article',
                content: 'Body',
            })
        }
    })

    it('uploads a screenshot and returns updated article', async () => {
        supportKnowledgeRepositoryMock.findById.mockResolvedValue({
            id: 11n,
            title: 'Article',
            content: 'Content',
            category: null,
            isActive: true,
            screenshotKey: null,
            embeddingIndexed: true,
            createdAt: new Date('2026-05-08T10:00:00.000Z'),
            updatedAt: new Date('2026-05-08T10:00:00.000Z'),
        })
        supportKnowledgeRepositoryMock.setScreenshot.mockResolvedValue(undefined)

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.uploadScreenshot(11n, {
            name: 'screenshot.png',
            filename: 'screenshot.png',
            type: 'image/png',
            data: PNG_BYTES,
        })

        expect(Result.isOk(result)).toBe(true)
        expect(uploadToS3Mock).toHaveBeenCalledWith(
            expect.stringContaining('knowledge-base/11/'),
            expect.any(Buffer),
            'image/png',
            { publicRead: true },
        )
        expect(supportKnowledgeRepositoryMock.setScreenshot).toHaveBeenCalledWith(
            11n,
            expect.stringContaining('knowledge-base/11/'),
            'image/png',
        )
        if (Result.isOk(result)) {
            expect(result.value.item).toMatchObject({
                id: '11',
                hasScreenshot: true,
                screenshotKey: expect.stringContaining('knowledge-base/11/'),
            })
        }
    })

    it('rejects a screenshot whose bytes do not match the declared type (item 46)', async () => {
        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.uploadScreenshot(11n, {
            name: 'screenshot.png',
            filename: 'screenshot.png',
            type: 'image/png',
            data: JPEG_BYTES,
        })

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toMatchObject({ _tag: 'BadRequest' })
        }
        expect(uploadToS3Mock).not.toHaveBeenCalled()
    })

    it('returns not found for deleteScreenshot on missing article', async () => {
        supportKnowledgeRepositoryMock.findById.mockResolvedValue(undefined)

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.deleteScreenshot(11n)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'Article',
                message: 'Article not found',
            })
        }
    })

    it('returns the CDN url of the screenshot', async () => {
        supportKnowledgeRepositoryMock.findById.mockResolvedValue({
            id: 11n,
            title: 'Article',
            content: 'Content',
            category: null,
            isActive: true,
            screenshotKey: 'kb/11/screenshot.png',
            embeddingIndexed: true,
            createdAt: new Date('2026-05-08T10:00:00.000Z'),
            updatedAt: new Date('2026-05-08T10:00:00.000Z'),
        })

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.getScreenshotUrl(11n)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.url).toMatch(
                /^https:\/\/cdn\.test\/[^/].*\/kb\/11\/screenshot\.png$/,
            )
        }
    })

    it('returns no url when CDN_URL is not set', async () => {
        appConfigMock.cdnUrl = ''
        supportKnowledgeRepositoryMock.findById.mockResolvedValue({
            id: 11n,
            title: 'Article',
            content: 'Content',
            category: null,
            isActive: true,
            screenshotKey: 'kb/11/screenshot.png',
            embeddingIndexed: true,
            createdAt: new Date('2026-05-08T10:00:00.000Z'),
            updatedAt: new Date('2026-05-08T10:00:00.000Z'),
        })

        const { knowledgeBaseService } = await loadKnowledgeBaseService()
        const result = await knowledgeBaseService.getScreenshotUrl(11n)

        expect(result).toEqual(Result.ok({ url: null }))
        expect(loggerMock.warn).toHaveBeenCalled()
    })
})
