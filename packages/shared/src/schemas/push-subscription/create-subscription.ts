import { type } from '@arktype/type'

// The bounds are the columns of `push_subscriptions` (varchar) and, for the text columns, a
// size no browser comes near: a longer value used to reach the INSERT and come back as a 500
// (feat-156). The address of the device is not part of the request: the server stores the one
// it sees.
export const CreateSubscriptionInputSchema = type({
    endpoint: '1 <= string <= 500',
    // A P-256 public key is 87 base64url characters, the auth secret 22.
    p256dhKey: '1 <= string <= 255',
    authKey: '1 <= string <= 255',
    'userAgent?': 'string <= 1024',
    'deviceType?': 'string <= 50',
    'browserName?': 'string <= 100',
    'browserVersion?': 'string <= 50',
    'osName?': 'string <= 100',
    'osVersion?': 'string <= 50',
    // Two kinds exist; a longer list is repetition.
    'notificationTypes?': "('mention' | 'system')[] <= 10",
    'timezone?': 'string <= 50',
    '+': 'reject',
})

export type CreateSubscriptionInput = typeof CreateSubscriptionInputSchema.infer
