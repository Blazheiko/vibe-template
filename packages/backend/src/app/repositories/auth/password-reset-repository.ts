import { passwordResetTokens } from '#database/schema.js'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import { createTokenRepository, type ITokenRepository } from './token-repository.js'

export type PasswordResetTokenRow = InferSelectModel<typeof passwordResetTokens>
export type PasswordResetTokenInsert = InferInsertModel<typeof passwordResetTokens>

export type IPasswordResetRepository = ITokenRepository<
    PasswordResetTokenRow,
    PasswordResetTokenInsert
>

export const passwordResetRepository: IPasswordResetRepository = createTokenRepository(
    passwordResetTokens,
    'Failed to create password reset token',
)
