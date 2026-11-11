import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    JPEG_BYTES,
    NOT_AN_IMAGE,
    PNG_BYTES,
    WEBP_BYTES,
} from '../../../test-support/image-fixtures.js'

const userRepositoryMock = {
    findById: vi.fn(),
    update: vi.fn(),
    updateIfSessionToken: vi.fn(),
    replaceAvatarIfSessionToken: vi.fn(),
}

const SESSION_TOKEN = 'presented-token'

const uploadToS3Mock = vi.fn()
const deleteFromS3Mock = vi.fn()

const loggerMock = {
    warn: vi.fn(),
}

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
}))

vi.mock('#vendor/utils/storage/s3.js', () => ({
    uploadToS3: uploadToS3Mock,
    deleteFromS3: deleteFromS3Mock,
}))

vi.mock('#logger', () => ({
    default: loggerMock,
}))

async function loadAvatarService() {
    return import('./avatar-service.js')
}

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

describe('avatarService', () => {
    it('uploads an avatar', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: null,
            sessionToken: SESSION_TOKEN,
        })
        uploadToS3Mock.mockResolvedValue(undefined)
        userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
            user: {
                id: 7n,
                name: 'Alice',
                email: 'alice@example.com',
                avatar: 'avatars/7/avatar.webp',
            },
            previousAvatar: null,
        })

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.uploadAvatar(
            7n,
            {
                filename: 'avatar',
                type: 'image/webp',
                data: WEBP_BYTES,
            } as never,
            SESSION_TOKEN,
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.user).toEqual({
                id: '7',
                name: 'Alice',
                email: 'alice@example.com',
                avatar: 'avatars/7/avatar.webp',
            })
        }
    })

    describe('content check and storage (code-issues items 44, 45, 46)', () => {
        const user = {
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: null,
            sessionToken: SESSION_TOKEN,
        }

        it('stores a PNG publicly under a .png key, ignoring the client file name', async () => {
            userRepositoryMock.findById.mockResolvedValue(user)
            uploadToS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                user: {
                    ...user,
                    avatar: 'avatars/7/x.png',
                },
                previousAvatar: null,
            })

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(
                7n,
                {
                    filename: 'evil.exe',
                    type: 'image/png',
                    data: PNG_BYTES,
                } as never,
                SESSION_TOKEN,
            )

            expect(Result.isOk(result)).toBe(true)
            expect(uploadToS3Mock).toHaveBeenCalledWith(
                expect.stringMatching(/^avatars\/7\/[0-9a-f-]{36}\.png$/),
                expect.any(Buffer),
                'image/png',
                { publicRead: true },
            )
        })

        it.each([
            ['bytes that are not an image', 'image/png', NOT_AN_IMAGE],
            ['a JPEG declared as PNG', 'image/png', JPEG_BYTES],
        ])('rejects %s with 400 and uploads nothing', async (_name, type, data) => {
            userRepositoryMock.findById.mockResolvedValue(user)

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(
                7n,
                {
                    filename: 'a.png',
                    type,
                    data,
                } as never,
                SESSION_TOKEN,
            )

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({ _tag: 'BadRequest' })
            }
            expect(uploadToS3Mock).not.toHaveBeenCalled()
        })

        it('deletes the old avatar by its stored relative key', async () => {
            userRepositoryMock.findById.mockResolvedValue({ ...user, avatar: 'avatars/7/old.webp' })
            uploadToS3Mock.mockResolvedValue(undefined)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                user: {
                    ...user,
                    avatar: 'avatars/7/new.webp',
                },
                previousAvatar: 'avatars/7/old.webp',
            })

            const { avatarService } = await loadAvatarService()
            await avatarService.uploadAvatar(
                7n,
                {
                    filename: 'a.webp',
                    type: 'image/webp',
                    data: WEBP_BYTES,
                } as never,
                SESSION_TOKEN,
            )

            expect(deleteFromS3Mock).toHaveBeenCalledWith('avatars/7/old.webp')
        })
    })

    it('logs best-effort avatar cleanup failures without failing upload', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: 'avatars/7/old.webp',
            sessionToken: SESSION_TOKEN,
        })
        uploadToS3Mock.mockResolvedValue(undefined)
        deleteFromS3Mock.mockRejectedValue(new Error('S3 delete failed'))
        userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
            user: {
                id: 7n,
                name: 'Alice',
                email: 'alice@example.com',
                avatar: 'avatars/7/new.webp',
            },
            previousAvatar: 'avatars/7/old.webp',
        })

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.uploadAvatar(
            7n,
            {
                filename: 'avatar.webp',
                type: 'image/webp',
                data: WEBP_BYTES,
            } as never,
            SESSION_TOKEN,
        )

        expect(Result.isOk(result)).toBe(true)
        expect(loggerMock.warn).toHaveBeenCalledWith(
            { key: 'avatars/7/old.webp', err: expect.any(Error) },
            'Failed to delete avatar S3 object',
        )
    })

    it('returns not found for missing user on deleteAvatar', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.deleteAvatar(7n, SESSION_TOKEN)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'User',
                message: 'User not found',
            })
        }
    })
    // feat-096: the avatar changes only while the session that asked is still current.
    describe('session guard (feat-096)', () => {
        const owner = {
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: 'avatars/7/old.webp',
            sessionToken: SESSION_TOKEN,
        }
        const webp = { filename: 'a.webp', type: 'image/webp', data: WEBP_BYTES } as never
        const revoked = {
            _tag: 'Unauthorized',
            message: 'Session has been revoked',
            reason: 'session_revoked',
        }

        it.each([
            ['no presented token', undefined],
            ['a presented token that is no longer current', 'stale-token'],
        ])('uploadAvatar refuses %s with 401 and writes nothing', async (_name, presented) => {
            userRepositoryMock.findById.mockResolvedValue(owner)

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(7n, webp, presented)

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(result.error).toEqual(revoked)
            expect(uploadToS3Mock).not.toHaveBeenCalled()
            expect(userRepositoryMock.replaceAvatarIfSessionToken).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(deleteFromS3Mock).not.toHaveBeenCalled()
        })

        it('uploadAvatar takes back the new object and keeps the old one when the write loses', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            uploadToS3Mock.mockResolvedValue(undefined)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue(undefined)

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(7n, webp, SESSION_TOKEN)

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(result.error).toEqual(revoked)
            const newKey = uploadToS3Mock.mock.calls[0]?.[0] as string
            expect(newKey).toMatch(/^avatars\/7\/[0-9a-f-]{36}\.webp$/)
            expect(userRepositoryMock.replaceAvatarIfSessionToken).toHaveBeenCalledWith(
                7n,
                SESSION_TOKEN,
                newKey,
            )
            expect(deleteFromS3Mock).toHaveBeenCalledTimes(1)
            expect(deleteFromS3Mock).toHaveBeenCalledWith(newKey)
            expect(deleteFromS3Mock).not.toHaveBeenCalledWith('avatars/7/old.webp')
        })

        it('uploadAvatar deletes the old object only after the conditional write', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            uploadToS3Mock.mockResolvedValue(undefined)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                user: {
                    ...owner,
                    avatar: 'avatars/7/new.webp',
                },
                previousAvatar: 'avatars/7/old.webp',
            })

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(7n, webp, SESSION_TOKEN)

            expect(Result.isOk(result)).toBe(true)
            expect(deleteFromS3Mock).toHaveBeenCalledWith('avatars/7/old.webp')
            expect(
                userRepositoryMock.replaceAvatarIfSessionToken.mock.invocationCallOrder[0],
            ).toBeLessThan(deleteFromS3Mock.mock.invocationCallOrder[0] ?? 0)
        })

        it('deleteAvatar refuses a request without a presented token and writes nothing', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.deleteAvatar(7n, undefined)

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(result.error).toEqual(revoked)
            expect(userRepositoryMock.replaceAvatarIfSessionToken).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(deleteFromS3Mock).not.toHaveBeenCalled()
        })

        it('deleteAvatar keeps the object when the conditional write loses', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue(undefined)

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.deleteAvatar(7n, 'stale-token')

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(result.error).toEqual(revoked)
            expect(userRepositoryMock.replaceAvatarIfSessionToken).toHaveBeenCalledWith(
                7n,
                'stale-token',
                null,
            )
            expect(deleteFromS3Mock).not.toHaveBeenCalled()
        })

        it('deleteAvatar clears the row, then deletes the old object', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                user: { ...owner, avatar: null },
                previousAvatar: 'avatars/7/old.webp',
            })

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.deleteAvatar(7n, SESSION_TOKEN)

            expect(Result.isOk(result)).toBe(true)
            expect(userRepositoryMock.replaceAvatarIfSessionToken).toHaveBeenCalledWith(
                7n,
                SESSION_TOKEN,
                null,
            )
            expect(deleteFromS3Mock).toHaveBeenCalledWith('avatars/7/old.webp')
            expect(
                userRepositoryMock.replaceAvatarIfSessionToken.mock.invocationCallOrder[0],
            ).toBeLessThan(deleteFromS3Mock.mock.invocationCallOrder[0] ?? 0)
        })

        // feat-161 (review 2026-11-10): an account created through OAuth has the provider's
        // picture URL in users.avatar. It is not an object of this storage: nothing to delete.
        it.each(['https://lh3.googleusercontent.com/a/photo', 'http://cdn.example.com/a.png'])(
            'deleteAvatar clears a provider picture (%s) without a storage request',
            async (pictureUrl) => {
                userRepositoryMock.findById.mockResolvedValue(owner)
                userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                    user: { ...owner, avatar: null },
                    previousAvatar: pictureUrl,
                })

                const { avatarService } = await loadAvatarService()
                const result = await avatarService.deleteAvatar(7n, SESSION_TOKEN)

                expect(Result.isOk(result)).toBe(true)
                expect(deleteFromS3Mock).not.toHaveBeenCalled()
            },
        )

        // feat-116: the object deleted is the one the row held when the key was swapped, not the
        // one read before the upload: a concurrent change in between has set another one.
        it('uploadAvatar deletes the key the swap replaced, not the one read before', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            uploadToS3Mock.mockResolvedValue(undefined)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue({
                user: { ...owner, avatar: 'avatars/7/new.webp' },
                previousAvatar: 'avatars/7/concurrent.webp',
            })

            const { avatarService } = await loadAvatarService()
            await avatarService.uploadAvatar(7n, webp, SESSION_TOKEN)

            expect(deleteFromS3Mock).toHaveBeenCalledTimes(1)
            expect(deleteFromS3Mock).toHaveBeenCalledWith('avatars/7/concurrent.webp')
        })

        // feat-130: PostgreSQL answered with an error (a SQLSTATE): the swap rolled back.
        it('uploadAvatar takes back the new object when the database rejects the swap', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            uploadToS3Mock.mockResolvedValue(undefined)
            deleteFromS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockRejectedValue(
                Object.assign(new Error('could not serialize access'), {
                    code: '40001',
                    severity: 'ERROR',
                }),
            )

            const { avatarService } = await loadAvatarService()
            await expect(avatarService.uploadAvatar(7n, webp, SESSION_TOKEN)).rejects.toThrow(
                'could not serialize access',
            )

            const newKey = uploadToS3Mock.mock.calls[0]?.[0] as string
            expect(deleteFromS3Mock).toHaveBeenCalledTimes(1)
            expect(deleteFromS3Mock).toHaveBeenCalledWith(newKey)
        })

        // feat-130: no answer (a timeout, a dropped connection): the COMMIT may have gone through.
        it('uploadAvatar keeps the new object when the swap failed without an answer', async () => {
            userRepositoryMock.findById.mockResolvedValue(owner)
            uploadToS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.replaceAvatarIfSessionToken.mockRejectedValue(
                new Error('Query read timeout'),
            )

            const { avatarService } = await loadAvatarService()
            await expect(avatarService.uploadAvatar(7n, webp, SESSION_TOKEN)).rejects.toThrow(
                'Query read timeout',
            )

            expect(deleteFromS3Mock).not.toHaveBeenCalled()
        })
    })
})
