import { ENTITY_ID_PATTERN } from 'shared/patterns'

export const ENTITY_ID_REGEX = ENTITY_ID_PATTERN

export function isCanonicalEntityId(value: string | undefined | null): value is string {
    return typeof value === 'string' && ENTITY_ID_REGEX.test(value)
}
