import { type } from '@arktype/type'
import { ENTITY_ID_PATTERN } from '../patterns/index.js'

// Canonical id of a database row as a string ("42"): a branded type, so a plain
// string has to pass the schema before it can be used as an EntityId.
export const EntityIdSchema = type(ENTITY_ID_PATTERN).brand('EntityId')
export type EntityId = typeof EntityIdSchema.infer
