import { type } from '@arktype/type'
import { isValidEntityId } from '../brand/index.js'
import { ENTITY_ID_PATTERN } from '../patterns/index.js'

/**
 * The canonical id of a database row as a string ("42"), up to the PostgreSQL `bigint` bound,
 * without a brand. Query, request and response schemas use it where a brand would leak to the
 * frontend (`QueryInputOf` reads values from `infer`). `isValidEntityId` is the whole check; the
 * pattern only makes the JSON Schema of the route show the shape.
 */
export const EntityIdStringSchema = type(ENTITY_ID_PATTERN).narrow((value) =>
    isValidEntityId(value),
)

// The same id as a branded type: a plain string has to pass the schema before it is an EntityId.
export const EntityIdSchema = EntityIdStringSchema.brand('EntityId')
export type EntityId = typeof EntityIdSchema.infer
