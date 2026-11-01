import { randomUUID } from 'node:crypto'
import type { UploadedFile } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { userRepository } from '#app/repositories/index.js'
import { uploadToS3, deleteFromS3 } from '#vendor/utils/storage/s3.js'
import {
    detectImageType,
    IMAGE_EXTENSIONS,
    type DetectedImageType,
} from '#vendor/utils/storage/detect-image-type.js'
import logger from '#logger'
import {
    badRequest,
    internalMessage,
    notFound,
    type AppResult,
} from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { AVATAR_MAX_FILE_BYTES } from '#app/services/shared/upload-limits.js'

const ALLOWED_TYPES: ReadonlySet<DetectedImageType> = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
])

interface AvatarUserPayload {
    id: string
    name: string
    email: string
    avatar: string | null
}

// The declared multipart type must match the file's bytes (code-issues item 46).
function verifiedImageType(file: UploadedFile): DetectedImageType | undefined {
    const detected = detectImageType(file.data)
    return detected !== undefined && ALLOWED_TYPES.has(detected) && detected === file.type
        ? detected
        : undefined
}

function serializeUser(user: {
    id: bigint
    name: string
    email: string | null
    avatar: string | null | undefined
}): AvatarUserPayload {
    return {
        id: String(user.id),
        name: user.name,
        email: user.email ?? '',
        avatar: user.avatar ?? null,
    }
}

export const avatarService = {
    async uploadAvatar(
        userId: bigint,
        file: UploadedFile | undefined,
    ): Promise<AppResult<{ user: AvatarUserPayload }>> {
        if (file === undefined) {
            return Result.err(badRequest('No file uploaded'))
        }

        if (file.data.byteLength > AVATAR_MAX_FILE_BYTES) {
            return Result.err(badRequest('File size exceeds 10 MB limit'))
        }

        const imageType = verifiedImageType(file)
        if (imageType === undefined) {
            return Result.err(badRequest('Invalid file type. Allowed: jpeg, png, webp'))
        }

        const userResult = await tryInternal(
            () => userRepository.findById(userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }
        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        // Extension from the verified type; the client's file name is not used.
        const s3Key = `avatars/${String(userId)}/${randomUUID()}.${IMAGE_EXTENSIONS[imageType]}`

        const uploadResult = await tryInternal(
            // Public like KB screenshots: the frontend loads avatars from CDN_URL (decision R1).
            () => uploadToS3(s3Key, Buffer.from(file.data), imageType, { publicRead: true }),
            'Failed to upload avatar',
        )
        if (Result.isError(uploadResult)) {
            return Result.err(uploadResult.error)
        }

        const oldAvatarKey = user.avatar
        if (oldAvatarKey !== null) {
            const deleteOldAvatarResult = await tryInternal(
                () => deleteFromS3(oldAvatarKey),
                'Failed to delete old avatar',
            )
            if (Result.isError(deleteOldAvatarResult)) {
                // Best-effort cleanup: keep the upload flow alive, but do not swallow the cause.
                logger.warn(
                    { err: deleteOldAvatarResult.error, oldAvatarKey },
                    'Failed to delete old avatar S3 object',
                )
            }
        }

        const updatedResult = await tryInternal(
            () => userRepository.update(userId, { avatar: s3Key }),
            'Failed to update user',
        )
        if (Result.isError(updatedResult)) {
            return Result.err(updatedResult.error)
        }

        const updated = updatedResult.value
        if (updated === undefined) {
            return Result.err(internalMessage('Failed to update user'))
        }

        return Result.ok({ user: serializeUser(updated) })
    },

    async deleteAvatar(userId: bigint): Promise<AppResult<{ user: AvatarUserPayload }>> {
        const userResult = await tryInternal(
            () => userRepository.findById(userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        const avatarKey = user.avatar
        if (avatarKey !== null) {
            const deleteAvatarResult = await tryInternal(
                () => deleteFromS3(avatarKey),
                'Failed to delete avatar',
            )
            if (Result.isError(deleteAvatarResult)) {
                // Best-effort cleanup: preserve the main delete flow, but log the failure.
                logger.warn(
                    { err: deleteAvatarResult.error, avatarKey },
                    'Failed to delete avatar S3 object',
                )
            }
        }

        const updatedResult = await tryInternal(
            () => userRepository.update(userId, { avatar: null }),
            'Failed to update user',
        )
        if (Result.isError(updatedResult)) {
            return Result.err(updatedResult.error)
        }

        const updated = updatedResult.value
        if (updated === undefined) {
            return Result.err(internalMessage('Failed to update user'))
        }

        return Result.ok({ user: serializeUser(updated) })
    },
}
