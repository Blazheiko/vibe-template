import { emailLinkVerifications } from '#database/schema.js'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import { createTokenRepository, type ITokenRepository } from './token-repository.js'

export type EmailLinkVerificationRow = InferSelectModel<typeof emailLinkVerifications>
export type EmailLinkVerificationInsert = InferInsertModel<typeof emailLinkVerifications>

export type IEmailLinkVerificationRepository = ITokenRepository<
    EmailLinkVerificationRow,
    EmailLinkVerificationInsert
>

export const emailLinkVerificationRepository: IEmailLinkVerificationRepository =
    createTokenRepository(emailLinkVerifications, 'Failed to create email link verification')
