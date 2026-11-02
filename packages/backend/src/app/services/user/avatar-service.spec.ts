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
}

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
        })
        uploadToS3Mock.mockResolvedValue(undefined)
        userRepositoryMock.update.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: 'avatars/7/avatar.webp',
        })

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.uploadAvatar(7n, {
            filename: 'avatar',
            type: 'image/webp',
            data: WEBP_BYTES,
        } as never)

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
        const user = { id: 7n, name: 'Alice', email: 'alice@example.com', avatar: null }

        it('stores a PNG publicly under a .png key, ignoring the client file name', async () => {
            userRepositoryMock.findById.mockResolvedValue(user)
            uploadToS3Mock.mockResolvedValue(undefined)
            userRepositoryMock.update.mockResolvedValue({ ...user, avatar: 'avatars/7/x.png' })

            const { avatarService } = await loadAvatarService()
            const result = await avatarService.uploadAvatar(7n, {
                filename: 'evil.exe',
                type: 'image/png',
                data: PNG_BYTES,
            } as never)

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
            const result = await avatarService.uploadAvatar(7n, {
                filename: 'a.png',
                type,
                data,
            } as never)

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
            userRepositoryMock.update.mockResolvedValue({ ...user, avatar: 'avatars/7/new.webp' })

            const { avatarService } = await loadAvatarService()
            await avatarService.uploadAvatar(7n, {
                filename: 'a.webp',
                type: 'image/webp',
                data: WEBP_BYTES,
            } as never)

            expect(deleteFromS3Mock).toHaveBeenCalledWith('avatars/7/old.webp')
        })
    })

    it('logs best-effort avatar cleanup failures without failing upload', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: 'avatars/7/old.webp',
        })
        uploadToS3Mock.mockResolvedValue(undefined)
        deleteFromS3Mock.mockRejectedValue(new Error('S3 delete failed'))
        userRepositoryMock.update.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            email: 'alice@example.com',
            avatar: 'avatars/7/new.webp',
        })

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.uploadAvatar(7n, {
            filename: 'avatar.webp',
            type: 'image/webp',
            data: WEBP_BYTES,
        } as never)

        expect(Result.isOk(result)).toBe(true)
        expect(loggerMock.warn).toHaveBeenCalledWith(
            { key: 'avatars/7/old.webp', err: expect.any(Error) },
            'Failed to delete avatar S3 object',
        )
    })

    it('returns not found for missing user on deleteAvatar', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)

        const { avatarService } = await loadAvatarService()
        const result = await avatarService.deleteAvatar(7n)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'User',
                message: 'User not found',
            })
        }
    })
})
