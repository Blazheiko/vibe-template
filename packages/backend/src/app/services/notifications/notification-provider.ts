import { OAuthProviderSchema, type OAuthProvider } from 'shared/responses'

import logger from '#vendor/utils/logger.js'

/**
 * The provider of a stored identity as a notification names it (Р2). Identities are only linked
 * for the supported providers, so null is a bug: it is logged and the caller sends no notice.
 */
export const asNotificationProvider = (provider: string): OAuthProvider | null => {
    if (OAuthProviderSchema.allows(provider)) return provider
    logger.error({ provider }, 'Sign-in method notice: a provider outside the catalog')
    return null
}
