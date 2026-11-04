import { afterEach, describe, expect, it, vi } from 'vitest'
import { PNG_BYTES } from '../../../../test-support/image-fixtures.js'

const userRepositoryMock = {
    findById: vi.fn(),
    update: vi.fn(),
    updateIfSessionToken: vi.fn(),
    replaceAvatarIfSessionToken: vi.fn(),
}
const uploadToS3Mock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({ userRepository: userRepositoryMock }))
vi.mock('#vendor/utils/storage/s3.js', () => ({
    uploadToS3: uploadToS3Mock,
    deleteFromS3: vi.fn(),
}))

const { default: AvatarController } = await import('./avatar-controller.js')

const createContext = () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const context = {
        logger,
        auth: { check: () => true, getUserId: () => '7', getPresentedUserToken: () => 'token-7' },
        httpData: {
            files: new Map([['avatar', { data: PNG_BYTES, type: 'image/png', filename: 'a.png' }]]),
        },
        responseData: { status: 200, setHeader: vi.fn() },
        signal: new AbortController().signal,
    }
    return context as unknown as Parameters<typeof AvatarController.uploadAvatar>[0] & {
        logger: typeof logger
    }
}

afterEach(() => {
    vi.clearAllMocks()
})

// Before feat-086 a failed upload answered 500 and left nothing in the log or Sentry.
// Since feat-089 (ADR 0004) the storage error is not wrapped at all: it propagates to
// handleError, which answers 500 and logs it once with the request context
// (handle-error-logging.spec.ts, classify-error.spec.ts).
describe('AvatarController.uploadAvatar when storage fails', () => {
    it('lets the storage error reach the transport instead of hiding it in a Result', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            avatar: null,
            sessionToken: 'token-7',
        })
        const s3Error = new Error('S3 is down')
        uploadToS3Mock.mockRejectedValue(s3Error)
        const context = createContext()

        await expect(AvatarController.uploadAvatar(context)).rejects.toBe(s3Error)
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
        expect(userRepositoryMock.replaceAvatarIfSessionToken).not.toHaveBeenCalled()
    })
})

// feat-096: the controller hands the service the token the request presented.
describe('AvatarController passes the presented session token', () => {
    it('uploadAvatar and deleteAvatar refuse a presented token that is no longer current', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Alice',
            avatar: null,
            sessionToken: 'rotated-token',
        })
        userRepositoryMock.replaceAvatarIfSessionToken.mockResolvedValue(undefined)
        const context = createContext()

        const uploaded = await AvatarController.uploadAvatar(context)
        expect(uploadToS3Mock).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(401)
        expect(uploaded).toMatchObject({ reason: 'session_revoked' })

        context.responseData.status = 200
        const deleted = await AvatarController.deleteAvatar(context)
        expect(userRepositoryMock.replaceAvatarIfSessionToken).toHaveBeenCalledWith(
            7n,
            'token-7',
            null,
        )
        expect(context.responseData.status).toBe(401)
        expect(deleted).toMatchObject({ reason: 'session_revoked' })
    })
})
