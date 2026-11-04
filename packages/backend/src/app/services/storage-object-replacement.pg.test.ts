import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../test-support/pg-test-db.js'
import { PNG_BYTES } from '../../test-support/image-fixtures.js'

// feat-116 (R11d) on real PostgreSQL with an in-memory S3: a KB screenshot and an avatar are
// replaced in one order - upload the new object, swap the key in the locked row (which returns
// the key it replaced), delete that key. Whatever the interleaving, the storage ends holding
// exactly the object the row points at.

const s3 = vi.hoisted(() => ({
    objects: new Map<string, number>(),
    failUpload: false,
    // When set, an upload waits until the test lets it go.
    holdUploads: 0,
    held: [] as (() => void)[],
}))
vi.mock('#vendor/utils/storage/s3.js', () => ({
    uploadToS3: async (key: string, data: Buffer) => {
        if (s3.failUpload) throw new Error('S3 upload failed')
        if (s3.holdUploads > 0) {
            s3.holdUploads -= 1
            await new Promise<void>((resolve) => {
                s3.held.push(resolve)
            })
        }
        s3.objects.set(key, data.byteLength)
    },
    deleteFromS3: (key: string) => {
        s3.objects.delete(key)
        return Promise.resolve()
    },
    buildObjectKey: (key: string) => key,
}))
const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !condition(); i += 1) await sleep(5)
    if (!condition()) throw new Error('condition not reached')
}
const png = { filename: 'a.png', type: 'image/png', data: PNG_BYTES } as never
const objectsUnder = (prefix: string): string[] =>
    [...s3.objects.keys()].filter((key) => key.startsWith(prefix)).sort()

describe.skipIf(!hasPg)('storage object replacement (feat-116)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { supportKnowledgeBase, users } = await import('#database/schema.js')
    const { supportKnowledgeRepository, userRepository } =
        await import('#app/repositories/index.js')
    const { knowledgeBaseService } = await import('#app/services/support/knowledge-base-service.js')
    const { avatarService } = await import('#app/services/user/avatar-service.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const articleIds: bigint[] = []
    const userIds: bigint[] = []
    let counter = 0

    afterEach(() => {
        vi.restoreAllMocks()
        s3.failUpload = false
        s3.holdUploads = 0
        for (const release of s3.held.splice(0)) release()
    })

    afterAll(async () => {
        if (articleIds.length > 0) {
            await db
                .delete(supportKnowledgeBase)
                .where(inArray(supportKnowledgeBase.id, articleIds))
        }
        if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds))
        await sessionCheckPool.end()
        await pool.end()
    })

    // ---- KB screenshot -------------------------------------------------------------------

    const newArticle = async (): Promise<bigint> => {
        const row = await supportKnowledgeRepository.create({ title: 'storage', content: 'c' })
        articleIds.push(row.id)
        return row.id
    }
    const screenshotKey = async (id: bigint): Promise<string | null | undefined> => {
        const [row] = await db
            .select({ key: supportKnowledgeBase.screenshotKey })
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
        return row === undefined ? undefined : row.key
    }
    const expectKbConsistent = async (id: bigint): Promise<void> => {
        const key = await screenshotKey(id)
        expect(objectsUnder(`knowledge-base/${String(id)}/`)).toEqual(
            key === null || key === undefined ? [] : [key],
        )
    }

    describe('KB screenshot', () => {
        it('two parallel uploads leave one object, the one the row points at', async () => {
            const id = await newArticle()
            expect((await knowledgeBaseService.uploadScreenshot(id, png)).isOk()).toBe(true)

            // Both upload before either swaps the key.
            s3.holdUploads = 2
            const both = Promise.all([
                knowledgeBaseService.uploadScreenshot(id, png),
                knowledgeBaseService.uploadScreenshot(id, png),
            ])
            await until(() => s3.held.length === 2)
            for (const release of s3.held.splice(0)) release()
            const results = await both

            expect(results.every((result) => result.isOk())).toBe(true)
            await expectKbConsistent(id)
            expect(objectsUnder(`knowledge-base/${String(id)}/`)).toHaveLength(1)
        })

        it('a failed upload leaves the old object and the row as they were', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png)
            const before = await screenshotKey(id)

            s3.failUpload = true
            await expect(knowledgeBaseService.uploadScreenshot(id, png)).rejects.toThrow(
                'S3 upload failed',
            )

            expect(await screenshotKey(id)).toBe(before)
            await expectKbConsistent(id)
        })

        it('a database failure after the upload takes the new object back, the old stays', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png)
            const before = await screenshotKey(id)
            vi.spyOn(supportKnowledgeRepository, 'replaceScreenshot').mockRejectedValueOnce(
                new Error('db down'),
            )

            await expect(knowledgeBaseService.uploadScreenshot(id, png)).rejects.toThrow('db down')

            expect(await screenshotKey(id)).toBe(before)
            await expectKbConsistent(id)
        })

        it('a removal that read the old key before an upload finished leaves no orphan', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png)

            // The removal reads the article, then waits until a whole upload has gone through.
            let resume: () => void = () => undefined
            const gate = new Promise<void>((resolve) => {
                resume = resolve
            })
            const read = supportKnowledgeRepository.findById.bind(supportKnowledgeRepository)
            vi.spyOn(supportKnowledgeRepository, 'findById').mockImplementationOnce(
                async (articleId) => {
                    const row = await read(articleId)
                    await gate
                    return row
                },
            )
            const removal = knowledgeBaseService.deleteScreenshot(id)
            await sleep(20)
            expect((await knowledgeBaseService.uploadScreenshot(id, png)).isOk()).toBe(true)
            resume()
            expect((await removal).isOk()).toBe(true)

            expect(await screenshotKey(id)).toBeNull()
            await expectKbConsistent(id)
        })

        it('deleting the article during an upload leaves no orphan', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png)

            s3.holdUploads = 1
            const upload = knowledgeBaseService.uploadScreenshot(id, png)
            await until(() => s3.held.length === 1)
            expect((await knowledgeBaseService.delete(id)).isOk()).toBe(true)
            for (const release of s3.held.splice(0)) release()

            const result = await upload
            expect(result.isErr()).toBe(true)
            expect(await screenshotKey(id)).toBeUndefined()
            expect(objectsUnder(`knowledge-base/${String(id)}/`)).toEqual([])
        })
    })

    // ---- Avatar --------------------------------------------------------------------------

    const newUser = async () => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({ name: 'avatar', email: `avatar-${run}-${String(counter)}@example.test` })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        userIds.push(row.id)
        return row
    }
    const avatarKey = async (id: bigint): Promise<string | null> => {
        const [row] = await db.select({ key: users.avatar }).from(users).where(eq(users.id, id))
        return row?.key ?? null
    }
    const expectAvatarConsistent = async (id: bigint): Promise<void> => {
        const key = await avatarKey(id)
        expect(objectsUnder(`avatars/${String(id)}/`)).toEqual(key === null ? [] : [key])
    }

    describe('avatar', () => {
        it('two parallel uploads leave one object, the one the row points at', async () => {
            const user = await newUser()
            await avatarService.uploadAvatar(user.id, png, user.sessionToken)

            s3.holdUploads = 2
            const both = Promise.all([
                avatarService.uploadAvatar(user.id, png, user.sessionToken),
                avatarService.uploadAvatar(user.id, png, user.sessionToken),
            ])
            await until(() => s3.held.length === 2)
            for (const release of s3.held.splice(0)) release()
            const results = await both

            expect(results.every((result) => result.isOk())).toBe(true)
            await expectAvatarConsistent(user.id)
            expect(objectsUnder(`avatars/${String(user.id)}/`)).toHaveLength(1)
        })

        it('a database failure after the upload takes the new object back, the old stays', async () => {
            const user = await newUser()
            await avatarService.uploadAvatar(user.id, png, user.sessionToken)
            const before = await avatarKey(user.id)
            vi.spyOn(userRepository, 'replaceAvatarIfSessionToken').mockRejectedValueOnce(
                new Error('db down'),
            )

            await expect(
                avatarService.uploadAvatar(user.id, png, user.sessionToken),
            ).rejects.toThrow('db down')

            expect(await avatarKey(user.id)).toBe(before)
            await expectAvatarConsistent(user.id)
        })

        it('a removal that read the old key before an upload finished leaves no orphan', async () => {
            const user = await newUser()
            await avatarService.uploadAvatar(user.id, png, user.sessionToken)

            let resume: () => void = () => undefined
            const gate = new Promise<void>((resolve) => {
                resume = resolve
            })
            const read = userRepository.findById.bind(userRepository)
            vi.spyOn(userRepository, 'findById').mockImplementationOnce(async (userId) => {
                const row = await read(userId)
                await gate
                return row
            })
            const removal = avatarService.deleteAvatar(user.id, user.sessionToken)
            await sleep(20)
            expect((await avatarService.uploadAvatar(user.id, png, user.sessionToken)).isOk()).toBe(
                true,
            )
            resume()
            expect((await removal).isOk()).toBe(true)

            expect(await avatarKey(user.id)).toBeNull()
            await expectAvatarConsistent(user.id)
        })
    })
})
