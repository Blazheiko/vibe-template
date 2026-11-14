import * as ResponseSchemas from 'shared/responses'
import { mainContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const mainSchemas = contractSchemas(mainContracts, {
    ping: { response: ResponseSchemas.PingResponseSchema },
    ready: { response: ResponseSchemas.ReadyResponseSchema },
    init: { response: ResponseSchemas.InitResponseSchema },
    updateWsToken: { response: ResponseSchemas.UpdateWsTokenResponseSchema },
})
