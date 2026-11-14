import type {
    InitResponse,
    PingResponse,
    ReadyResponse,
    UpdateWsTokenResponse,
} from '../responses/main-controller.js'
import { contract } from './core.js'

// `/ping` and `/ready` sit outside every route group; `main/*` is the app's own state.
export const mainContracts = {
    ping: contract<undefined, undefined, PingResponse>()('get', '/ping'),
    // 200 with `ok` when PostgreSQL and Redis answer, 503 with `unavailable` otherwise.
    ready: contract<undefined, undefined, ReadyResponse>()('get', '/ready'),
    init: contract<undefined, undefined, InitResponse>()('get', '/main/init'),
    updateWsToken: contract<undefined, undefined, UpdateWsTokenResponse>()(
        'get',
        '/main/update-ws-token',
    ),
} as const
