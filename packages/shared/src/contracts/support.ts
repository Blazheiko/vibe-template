import type { SupportChatHistoryQueryInput } from '../schemas/query/support.js'
import type {
    SupportDeleteChatHistoryResponse,
    SupportGetChatHistoryResponse,
    SupportScreenshotResponse,
} from '../responses/support-controller.js'
import { contract, navigationContract } from './core.js'

// The chat itself runs over the WebSocket (feat-171).
export const supportContracts = {
    history: contract<undefined, SupportChatHistoryQueryInput, SupportGetChatHistoryResponse>()(
        'get',
        '/support/chat/history',
    ),
    deleteHistory: contract<undefined, undefined, SupportDeleteChatHistoryResponse>()(
        'delete',
        '/support/chat/history',
    ),
    // A 302 to the stored image: an `<img src>` loads it, nothing fetches it.
    screenshot: navigationContract<undefined, SupportScreenshotResponse>()(
        '/support/screenshot/:articleId',
    ),
} as const
