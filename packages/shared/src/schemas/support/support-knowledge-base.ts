import { type } from '@arktype/type'

// `title` and `category` are varchar(255) and varchar(100): a longer value used to reach the
// INSERT and come back as a 500 (feat-161). `content` is text; its bound keeps an article a
// size an embedding request can carry.
export const SupportKnowledgeBaseCreateSchema = type({
    title: '1 <= string <= 255',
    content: '1 <= string <= 30000',
    'category?': 'string <= 100',
    'isActive?': 'boolean',
    '+': 'reject',
})

export type SupportKnowledgeBaseCreateInput = typeof SupportKnowledgeBaseCreateSchema.infer

export const SupportKnowledgeBaseUpdateSchema = type({
    'title?': '1 <= string <= 255',
    'content?': '1 <= string <= 30000',
    'category?': 'string <= 100',
    'isActive?': 'boolean',
    '+': 'reject',
})

export type SupportKnowledgeBaseUpdateInput = typeof SupportKnowledgeBaseUpdateSchema.infer
