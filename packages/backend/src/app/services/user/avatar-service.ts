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
    sessionRevoked,
    notFound,
    type AppResult,
} from '#app/services/shared/errors.js'
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

// Best-effort cleanup: a leftover S3 object must not fail the request, but is logged.
async function deleteAvatarObject(key: string): Promise<void> {
    try {
        await deleteFromS3(key)
    } catch (err: unknown) {
        logger.warn({ err, key }, 'Failed to delete avatar S3 object')
    }
}

export const avatarService = {
    /**
     * `presentedSessionToken`: `Auth.getPresentedUserToken()`. The row changes only while it
     * is still the user's current sessionToken (feat-096).
     */
    async uploadAvatar(
        userId: bigint,
        file: UploadedFile | undefined,
        presentedSessionToken: string | undefined,
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

        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        if (presentedSessionToken === undefined || user.sessionToken !== presentedSessionToken) {
            return Result.err(sessionRevoked())
        }

        // Extension from the verified type; the client's file name is not used.
        const s3Key = `avatars/${String(userId)}/${randomUUID()}.${IMAGE_EXTENSIONS[imageType]}`

        // Public like KB screenshots: the frontend loads avatars from CDN_URL (decision R1).
        await uploadToS3(s3Key, Buffer.from(file.data), imageType, { publicRead: true })

        // The row first, the old object after: a refused update (session revoked meanwhile)
        // must leave the current avatar in place and take back the new upload.
        const updated = await userRepository.updateIfSessionToken(userId, presentedSessionToken, {
            avatar: s3Key,
        })
        if (updated === undefined) {
            await deleteAvatarObject(s3Key)
            return Result.err(sessionRevoked())
        }

        if (user.avatar !== null) await deleteAvatarObject(user.avatar)

        return Result.ok({ user: serializeUser(updated) })
    },

    async deleteAvatar(
        userId: bigint,
        presentedSessionToken: string | undefined,
    ): Promise<AppResult<{ user: AvatarUserPayload }>> {
        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        if (presentedSessionToken === undefined) {
            return Result.err(sessionRevoked())
        }

        const updated = await userRepository.updateIfSessionToken(userId, presentedSessionToken, {
            avatar: null,
        })
        if (updated === undefined) {
            return Result.err(sessionRevoked())
        }

        if (user.avatar !== null) await deleteAvatarObject(user.avatar)

        return Result.ok({ user: serializeUser(updated) })
    },
}
