import { rateLimited, type AppError } from '#app/services/shared/errors.js'
import { diffMs, nowUnixMs, seconds, toSecondsCeil, unixMs } from 'shared/brand'
import { parseUserId, type UserId } from '#app/domain/ids.js'

export function extractChallengeUserId(metadata: unknown): UserId | null {
    if (
        metadata !== null &&
        typeof metadata === 'object' &&
        'userId' in metadata &&
        typeof metadata.userId === 'string'
    ) {
        return parseUserId(metadata.userId)
    }

    return null
}

export function extractChallengeSessionId(metadata: unknown): string | null {
    if (
        metadata !== null &&
        typeof metadata === 'object' &&
        'sessionId' in metadata &&
        typeof metadata.sessionId === 'string'
    ) {
        const normalizedSessionId = metadata.sessionId.trim()
        return normalizedSessionId === '' ? null : normalizedSessionId
    }

    return null
}

export function buildResendCooldownError(resendAvailableAt: Date): AppError {
    const retryAfterSeconds = seconds(
        Math.max(1, toSecondsCeil(diffMs(unixMs(resendAvailableAt.getTime()), nowUnixMs()))),
    )

    return rateLimited(
        'A verification code was already sent recently. Please wait before requesting another one.',
        {
            reason: 'resend_cooldown_active',
            retryAfterSeconds,
        },
    )
}
