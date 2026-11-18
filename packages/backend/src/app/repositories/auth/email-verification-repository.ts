import { emailVerifications } from '#database/schema.js'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { ExpiredRowsRepository } from './expired-rows.js'
import { createTokenRepository, type ITokenRepository } from './token-repository.js'

export type EmailVerificationRow = InferSelectModel<typeof emailVerifications>
export type EmailVerificationInsert = InferInsertModel<typeof emailVerifications>

export type IEmailVerificationRepository = ITokenRepository<
    EmailVerificationRow,
    EmailVerificationInsert
> &
    ExpiredRowsRepository

export const emailVerificationRepository: IEmailVerificationRepository = createTokenRepository(
    emailVerifications,
    'Failed to create email verification',
)
