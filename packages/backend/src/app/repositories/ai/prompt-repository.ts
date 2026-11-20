import { db } from '#database/db.js'
import { llmSystemPrompts } from '#database/schema.js'
import { eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import type { DbExecutor, DbTransaction } from '#app/repositories/transaction.js'

export type PromptRow = InferSelectModel<typeof llmSystemPrompts>
export type PromptType = PromptRow['type']

export interface PromptUpdate {
    content?: string
    model?: string | null
    temperature?: number | null
    maxTokens?: number | null
}

export interface IPromptRepository {
    findAll(): Promise<PromptRow[]>
    findByType(type: PromptType): Promise<PromptRow | undefined>
    /** The row, locked until the end of `tx` (feat-235): the "before" of an audited change. */
    lockByType(type: PromptType, tx: DbTransaction): Promise<PromptRow | undefined>
    /** Sets the given fields and returns the row as stored: the "after" of the change. */
    update(
        type: PromptType,
        data: PromptUpdate,
        executor: DbExecutor,
    ): Promise<PromptRow | undefined>
}

export const promptRepository: IPromptRepository = {
    async findAll() {
        return await db.select().from(llmSystemPrompts)
    },

    async findByType(type) {
        return await db
            .select()
            .from(llmSystemPrompts)
            .where(eq(llmSystemPrompts.type, type))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async lockByType(type, tx) {
        const [row] = await tx
            .select()
            .from(llmSystemPrompts)
            .where(eq(llmSystemPrompts.type, type))
            .for('update')
        return row
    },

    async update(type, data, executor) {
        const [updated] = await executor
            .update(llmSystemPrompts)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(llmSystemPrompts.type, type))
            .returning()
        return updated
    },
}
