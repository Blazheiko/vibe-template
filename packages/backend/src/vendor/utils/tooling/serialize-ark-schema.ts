import type { Type } from '@arktype/type'

import logger from '#vendor/utils/logger.js'

export interface SerializedSchemaField {
    name: string
    type: string
    required: boolean
}

export interface SerializedArkSchema {
    expression: string
    fields: SerializedSchemaField[]
    jsonSchema?: unknown
}

interface ArkPropNode {
    key: string
    value: { expression: string }
    required: boolean
    optional: boolean
}

const warnedExpressions = new Set<string>()

function warnSchemaExtractionFallback(expression: string): void {
    if (warnedExpressions.has(expression)) return
    warnedExpressions.add(expression)
    logger.warn({ expression }, 'serializeArkSchema: no props/jsonSchema')
}

/**
 * Extracts human-readable schema info from an ArkType Type object.
 *
 * Uses ArkType's public toJsonSchema() output for union/nested structure docs.
 * `fields` stays as a backward-compatible object-schema summary for the
 * existing playground UI; rejected alternative: walking ArkType branches would
 * rely on internal node shapes.
 */
export function serializeArkSchema(schema: Type): SerializedArkSchema {
    const expression = schema.expression
    const fields: SerializedSchemaField[] = []
    let jsonSchema: unknown

    try {
        // A `.narrow()` predicate (the bigint bound of an id, the rules of a profile name) has no
        // JSON Schema form: the docs show the shape it narrows and leave the predicate out.
        jsonSchema = schema.toJsonSchema({ fallback: { predicate: (ctx) => ctx.base } })
    } catch {
        jsonSchema = undefined
    }

    try {
        const props = (schema as unknown as { props?: ArkPropNode[] }).props
        if (Array.isArray(props)) {
            for (const prop of props) {
                if (typeof prop.key !== 'string') continue
                // Skip ArkType internal modifier keys like "+" (undeclared handling)
                if (prop.key.startsWith('+') || prop.key.startsWith('-')) continue

                fields.push({
                    name: prop.key,
                    type: prop.value.expression,
                    required: prop.required,
                })
            }
        }
    } catch {
        // structured extraction failed — return expression-only result
    }

    if (fields.length === 0 && jsonSchema === undefined) {
        warnSchemaExtractionFallback(expression)
    }

    return {
        expression,
        fields,
        ...(jsonSchema !== undefined ? { jsonSchema } : {}),
    }
}
