import type { PromptRow } from '#app/repositories/index.js'
import { toIsoDateTime, type EntityId, type IsoDateTime } from 'shared/brand'
import { toEntityId } from '#app/domain/ids.js'

// Wire shape of llm_system_prompts rows (feat-047): id as a string, dates as ISO strings.
export type SerializedPrompt = Omit<PromptRow, 'id' | 'createdAt' | 'updatedAt' | 'revision'> & {
    id: EntityId
    createdAt: IsoDateTime
    updatedAt: IsoDateTime
}

export const promptTransformer = {
    serialize(prompt: PromptRow): SerializedPrompt {
        // `revision` is the cache's version of the row (feat-235), not part of the API.
        const { id, createdAt, updatedAt, revision: _revision, ...rest } = prompt
        return {
            ...rest,
            id: toEntityId(id),
            createdAt: toIsoDateTime(createdAt),
            updatedAt: toIsoDateTime(updatedAt),
        }
    },

    serializeArray(prompts: PromptRow[]): SerializedPrompt[] {
        return prompts.map((prompt) => promptTransformer.serialize(prompt))
    },
}
