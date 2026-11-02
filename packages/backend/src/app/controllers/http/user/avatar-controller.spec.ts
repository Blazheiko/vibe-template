import { afterEach, describe, expect, it, vi } from 'vitest'
import { PNG_BYTES } from '../../../../test-support/image-fixtures.js'

const userRepositoryMock = { findById: vi.fn(), update: vi.fn() }
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
        auth: { check: () => true, getUserId: () => '7' },
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

// Before feat-086 a failed upload answered 500 and left nothing in the log or Sentry:
// tryInternal kept the exception in AppError.cause and mapControllerError only built the body.
describe('AvatarController.uploadAvatar when storage fails', () => {
    it('answers 500 and logs the storage error once', async () => {
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Alice', avatar: null })
        const s3Error = new Error('S3 is down')
        uploadToS3Mock.mockRejectedValue(s3Error)
        const context = createContext()

        const response = await AvatarController.uploadAvatar(context)

        expect(context.responseData.status).toBe(500)
        expect(response).toEqual({
            status: 'error',
            code: 'internal_error',
            message: 'Failed to upload avatar',
        })
        expect(context.logger.error).toHaveBeenCalledTimes(1)
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: s3Error, appError: 'Internal' },
            'Failed to upload avatar',
        )
    })
})
