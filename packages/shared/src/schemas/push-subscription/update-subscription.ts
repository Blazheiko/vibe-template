import { type } from '@arktype/type'

// The same bounds as in create-subscription.ts: the columns of `push_subscriptions`.
export const UpdateSubscriptionInputSchema = type({
    'isActive?': 'boolean',
    'notificationTypes?': "('mention' | 'system')[] <= 10",
    'timezone?': 'string <= 50',
    'deviceType?': 'string <= 50',
    'browserName?': 'string <= 100',
    'browserVersion?': 'string <= 50',
    'osName?': 'string <= 100',
    'osVersion?': 'string <= 50',
    '+': 'reject',
})

export type UpdateSubscriptionInput = typeof UpdateSubscriptionInputSchema.infer
