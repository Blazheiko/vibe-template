import { contractRouteDefiner } from '#app/routing/contract-registry.js'
import { adminSchemas } from './admin.js'
import { authSchemas } from './auth.js'
import { knowledgeBaseSchemas } from './knowledge-base.js'
import { pushSubscriptionSchemas } from './push-subscriptions.js'

// The schemas of every route declared through a contract, by `<method> <path>` of the contract
// (docs/adr/0005-route-contracts.md). One file per group of contracts in shared/contracts; a
// group's file names every contract of the group, or it does not compile.
export const contractSchemaRegistry = {
    ...adminSchemas,
    ...authSchemas,
    ...knowledgeBaseSchemas,
    ...pushSubscriptionSchemas,
}

/** A route of the route table declared through its contract; the schemas come from the registry. */
export const defineContractRoute = contractRouteDefiner(contractSchemaRegistry)
