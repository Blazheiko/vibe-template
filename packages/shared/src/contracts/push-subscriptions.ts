import type { CreateSubscriptionInputSchema } from '../schemas/push-subscription/create-subscription.js'
import type { UpdateSubscriptionInputSchema } from '../schemas/push-subscription/update-subscription.js'
import type { PushSubscriptionTestInputSchema } from '../schemas/index.js'
import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type {
    CreateSubscriptionResponse,
    DeactivateSubscriptionResponse,
    DeleteSubscriptionResponse,
    GetSubscriptionLogsResponse,
    GetSubscriptionResponse,
    GetSubscriptionStatisticsResponse,
    GetSubscriptionsResponse,
    GetVapidPublicKeyResponse,
    TestPushResponse,
    UpdateSubscriptionResponse,
} from '../responses/push-subscription-controller.js'
import { contract } from './core.js'

// Only types are imported from the schemas: nothing here loads them at run time.
export const pushSubscriptionContracts = {
    vapidPublicKey: contract<undefined, undefined, GetVapidPublicKeyResponse>()(
        'get',
        '/push-subscriptions/vapid-public-key',
    ),
    testPush: contract<
        typeof PushSubscriptionTestInputSchema.inferIn,
        undefined,
        TestPushResponse
    >()('post', '/push-subscriptions/test-push'),
    list: contract<undefined, undefined, GetSubscriptionsResponse>()('get', '/push-subscriptions'),
    create: contract<
        typeof CreateSubscriptionInputSchema.inferIn,
        undefined,
        CreateSubscriptionResponse
    >()('post', '/push-subscriptions'),
    get: contract<undefined, undefined, GetSubscriptionResponse>()(
        'get',
        '/push-subscriptions/:subscriptionId',
    ),
    update: contract<
        typeof UpdateSubscriptionInputSchema.inferIn,
        undefined,
        UpdateSubscriptionResponse
    >()('put', '/push-subscriptions/:subscriptionId'),
    remove: contract<undefined, undefined, DeleteSubscriptionResponse>()(
        'delete',
        '/push-subscriptions/:subscriptionId',
    ),
    logs: contract<undefined, undefined, GetSubscriptionLogsResponse>()(
        'get',
        '/push-subscriptions/:subscriptionId/logs',
    ),
    statistics: contract<undefined, undefined, GetSubscriptionStatisticsResponse>()(
        'get',
        '/push-subscriptions/:subscriptionId/statistics',
    ),
    deactivate: contract<
        typeof EmptyFormInputSchema.inferIn,
        undefined,
        DeactivateSubscriptionResponse
    >()('put', '/push-subscriptions/:subscriptionId/deactivate'),
} as const
