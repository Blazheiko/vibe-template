export const ENTITY_ID_REGEX = /^[1-9]\d*$/

export function isCanonicalEntityId(value: string | undefined | null): value is string {
    return typeof value === 'string' && ENTITY_ID_REGEX.test(value)
}
