import { type } from '@arktype/type'

// feat-097: the token of the mailed link that confirms an OAuth link.
export const OAuthLinkConfirmInputSchema = type({
    token: 'string >= 1 & string <= 255',
    '+': 'reject',
})

export type OAuthLinkConfirmInput = typeof OAuthLinkConfirmInputSchema.infer
