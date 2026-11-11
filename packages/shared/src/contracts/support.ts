import type { SupportChatHistoryQueryInput } from '../schemas/query/support.js'
import type {
    SupportDeleteChatHistoryResponse,
    SupportGetChatHistoryResponse,
} from '../responses/support-controller.js'
import { contract } from './core.js'

// The chat itself runs over the WebSocket (feat-171); the screenshot redirect is non-JSON and
// gets its contract in feat-177.
export const supportContracts = {
    history: contract<undefined, SupportChatHistoryQueryInput, SupportGetChatHistoryResponse>()(
        'get',
        '/support/chat/history',
    ),
    deleteHistory: contract<undefined, undefined, SupportDeleteChatHistoryResponse>()(
        'delete',
        '/support/chat/history',
    ),
} as const
