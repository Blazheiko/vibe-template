import { type } from '@arktype/type'
import { PUSH_ENDPOINT_MAX_LENGTH } from '../../limits/index.js'

export const LogoutInputSchema = type({
    // feat-254: this browser's push subscription. The server deletes its record of the user with
    // the session, and only when the session really ended (not on `logout_retry`). Bounded like
    // the endpoint of POST /push-subscriptions (varchar 500).
    'pushEndpoint?': type('string').atLeastLength(1).atMostLength(PUSH_ENDPOINT_MAX_LENGTH),
    '+': 'reject',
})

export type LogoutInput = typeof LogoutInputSchema.infer
