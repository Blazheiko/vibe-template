import type { PromptTestInputSchema } from '../schemas/main/prompt-test.js'
import type { PromptUpdateInputSchema } from '../schemas/main/prompt-update.js'
import type {
    PromptGetByTypeResponse,
    PromptGetListResponse,
    PromptTestResponse,
    PromptUpdateResponse,
} from '../responses/prompt-controller.js'
import { contract } from './core.js'

// The retained Support AI prompts (admin). No frontend page calls them yet.
export const promptContracts = {
    list: contract<undefined, undefined, PromptGetListResponse>()('get', '/prompts'),
    get: contract<undefined, undefined, PromptGetByTypeResponse>()('get', '/prompts/:type'),
    update: contract<typeof PromptUpdateInputSchema.inferIn, undefined, PromptUpdateResponse>()(
        'put',
        '/prompts/:type',
    ),
    test: contract<typeof PromptTestInputSchema.inferIn, undefined, PromptTestResponse>()(
        'post',
        '/prompts/:type/test',
    ),
} as const
