import {
    AdminKnowledgeBaseListQuerySchema,
    EmptyFormInputSchema,
    SupportKnowledgeBaseCreateSchema,
    SupportKnowledgeBaseUpdateSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { knowledgeBaseContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const knowledgeBaseSchemas = contractSchemas(knowledgeBaseContracts, {
    list: {
        query: AdminKnowledgeBaseListQuerySchema,
        response: ResponseSchemas.SupportKnowledgeBaseListResponseSchema,
    },
    get: { response: ResponseSchemas.SupportKnowledgeBaseItemResponseSchema },
    create: {
        body: SupportKnowledgeBaseCreateSchema,
        response: ResponseSchemas.SupportKnowledgeBaseItemResponseSchema,
    },
    update: {
        body: SupportKnowledgeBaseUpdateSchema,
        response: ResponseSchemas.SupportKnowledgeBaseItemResponseSchema,
    },
    remove: { response: ResponseSchemas.SupportKnowledgeBaseDeleteResponseSchema },
    removeScreenshot: { response: ResponseSchemas.SupportKnowledgeBaseItemResponseSchema },
    reindex: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.SupportKnowledgeBaseReindexResponseSchema,
    },
    reindexAll: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.SupportKnowledgeBaseReindexResponseSchema,
    },
    startInit: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.SupportKnowledgeBaseInitResponseSchema,
    },
    initStatus: { response: ResponseSchemas.SupportKnowledgeBaseInitResponseSchema },
})
