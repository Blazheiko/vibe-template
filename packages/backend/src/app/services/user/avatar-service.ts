import { isServerRejection } from '#app/repositories/db-errors.js'
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
    // users.avatar of an account created through OAuth holds the provider's picture URL, not a
    // key of this storage: there is no object to delete, and asking for one would be a
    // DeleteObject for a key like `<prefix>/https://…` (feat-161).
    if (/^https?:\/\//i.test(key)) return
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

        // feat-116: the row first, the old object after, and the old key is the one the row held
        // when it was swapped (not `user.avatar` read above): of two concurrent changes each
        // deletes what the other set, so no object is left behind. A refused or failed swap
        // (session revoked meanwhile) leaves the current avatar and takes back the new upload.
        let replaced: Awaited<ReturnType<typeof userRepository.replaceAvatarIfSessionToken>>
        try {
            replaced = await userRepository.replaceAvatarIfSessionToken(
                userId,
                presentedSessionToken,
                s3Key,
            )
        } catch (err: unknown) {
            // feat-130: the new object goes only when PostgreSQL answered with an error, i.e. the
            // transaction rolled back. Without an answer (a timeout, a dropped connection) the
            // COMMIT may have gone through and may not be visible to a re-read yet: the object
            // stays (an orphan beats a broken avatar).
            if (isServerRejection(err)) {
                await deleteAvatarObject(s3Key)
            } else {
                logger.warn(
                    { key: s3Key },
                    'Avatar swap failed without an answer from the database; new object kept',
                )
            }
            throw err
        }
        if (replaced === undefined) {
            await deleteAvatarObject(s3Key)
            return Result.err(sessionRevoked())
        }

        if (replaced.previousAvatar !== null) await deleteAvatarObject(replaced.previousAvatar)

        return Result.ok({ user: serializeUser(replaced.user) })
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

        const replaced = await userRepository.replaceAvatarIfSessionToken(
            userId,
            presentedSessionToken,
            null,
        )
        if (replaced === undefined) {
            return Result.err(sessionRevoked())
        }

        if (replaced.previousAvatar !== null) await deleteAvatarObject(replaced.previousAvatar)

        return Result.ok({ user: serializeUser(replaced.user) })
    },
}
