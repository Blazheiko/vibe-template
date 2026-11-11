import type { AdminKnowledgeBaseListQueryInput } from '../schemas/query/admin.js'
import type {
    SupportKnowledgeBaseCreateSchema,
    SupportKnowledgeBaseUpdateSchema,
} from '../schemas/support/support-knowledge-base.js'
import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type {
    SupportKnowledgeBaseDeleteResponse,
    SupportKnowledgeBaseInitResponse,
    SupportKnowledgeBaseItemResponse,
    SupportKnowledgeBaseListResponse,
    SupportKnowledgeBaseReindexResponse,
} from '../responses/support-controller.js'
import { contract } from './core.js'

type EmptyBody = typeof EmptyFormInputSchema.inferIn

// The admin side of the support knowledge base. The screenshot upload is multipart and gets its
// contract with the other non-JSON routes (feat-177).
export const knowledgeBaseContracts = {
    list: contract<undefined, AdminKnowledgeBaseListQueryInput, SupportKnowledgeBaseListResponse>()(
        'get',
        '/admin/knowledge-base',
    ),
    get: contract<undefined, undefined, SupportKnowledgeBaseItemResponse>()(
        'get',
        '/admin/knowledge-base/:id',
    ),
    create: contract<
        typeof SupportKnowledgeBaseCreateSchema.inferIn,
        undefined,
        SupportKnowledgeBaseItemResponse
    >()('post', '/admin/knowledge-base'),
    update: contract<
        typeof SupportKnowledgeBaseUpdateSchema.inferIn,
        undefined,
        SupportKnowledgeBaseItemResponse
    >()('put', '/admin/knowledge-base/:id'),
    remove: contract<undefined, undefined, SupportKnowledgeBaseDeleteResponse>()(
        'delete',
        '/admin/knowledge-base/:id',
    ),
    removeScreenshot: contract<undefined, undefined, SupportKnowledgeBaseItemResponse>()(
        'delete',
        '/admin/knowledge-base/:id/screenshot',
    ),
    reindex: contract<EmptyBody, undefined, SupportKnowledgeBaseReindexResponse>()(
        'post',
        '/admin/knowledge-base/:id/reindex',
    ),
    reindexAll: contract<EmptyBody, undefined, SupportKnowledgeBaseReindexResponse>()(
        'post',
        '/admin/knowledge-base/reindex-all',
    ),
    startInit: contract<EmptyBody, undefined, SupportKnowledgeBaseInitResponse>()(
        'post',
        '/admin/knowledge-base/init',
    ),
    initStatus: contract<undefined, undefined, SupportKnowledgeBaseInitResponse>()(
        'get',
        '/admin/knowledge-base/init-status',
    ),
} as const
