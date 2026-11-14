import {
    CreateSubscriptionInputSchema,
    EmptyFormInputSchema,
    PushSubscriptionTestInputSchema,
    UpdateSubscriptionInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { pushSubscriptionContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const pushSubscriptionSchemas = contractSchemas(pushSubscriptionContracts, {
    vapidPublicKey: { response: ResponseSchemas.GetVapidPublicKeyResponseSchema },
    testPush: {
        body: PushSubscriptionTestInputSchema,
        response: ResponseSchemas.TestPushResponseSchema,
    },
    list: { response: ResponseSchemas.GetSubscriptionsResponseSchema },
    create: {
        body: CreateSubscriptionInputSchema,
        response: ResponseSchemas.CreateSubscriptionResponseSchema,
    },
    get: { response: ResponseSchemas.GetSubscriptionResponseSchema },
    update: {
        body: UpdateSubscriptionInputSchema,
        response: ResponseSchemas.UpdateSubscriptionResponseSchema,
    },
    remove: { response: ResponseSchemas.DeleteSubscriptionResponseSchema },
    logs: { response: ResponseSchemas.GetSubscriptionLogsResponseSchema },
    statistics: { response: ResponseSchemas.GetSubscriptionStatisticsResponseSchema },
    deactivate: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.DeactivateSubscriptionResponseSchema,
    },
})
