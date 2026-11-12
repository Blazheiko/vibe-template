import { contractRouteDefiner, contractWsRouteDefiner } from '#app/routing/contract-registry.js'
import { adminSchemas } from './admin.js'
import { avatarSchemas } from './avatar.js'
import { authSchemas } from './auth.js'
import { knowledgeBaseSchemas } from './knowledge-base.js'
import { mainSchemas } from './main.js'
import { oauthSchemas } from './oauth.js'
import { promptSchemas } from './prompts.js'
import { pushSubscriptionSchemas } from './push-subscriptions.js'
import { supportSchemas } from './support.js'
import { adminWsSchemas, supportWsSchemas } from './ws.js'

// The schemas of every route declared through a contract, by `<method> <path>` of the contract
// (docs/adr/0005-route-contracts.md). One file per group of contracts in shared/contracts; a
// group's file names every contract of the group, or it does not compile.
export const contractSchemaRegistry = {
    ...adminSchemas,
    ...avatarSchemas,
    ...authSchemas,
    ...knowledgeBaseSchemas,
    ...mainSchemas,
    ...oauthSchemas,
    ...promptSchemas,
    ...pushSubscriptionSchemas,
    ...supportSchemas,
    ...adminWsSchemas,
    ...supportWsSchemas,
}

/**
 * The one way to declare a route of the application: its contract, its handler and its server
 * settings (middlewares, limits). The schemas come from the registry (ADR 0005).
 */
export const defineRoute = contractRouteDefiner(contractSchemaRegistry)

/** The one way to declare a WS route of the application: its contract, handler and settings. */
export const defineWsRoute = contractWsRouteDefiner(contractSchemaRegistry)
