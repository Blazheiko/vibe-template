import type { Type } from '@arktype/type'
import {
    serializeArkSchema,
    type SerializedArkSchema,
    type SerializedSchemaField,
} from '#vendor/utils/tooling/serialize-ark-schema.js'
import { resolveMaxBodySize, type BodyKind } from '#vendor/utils/network/http-request-handlers.js'
import { isBodyMethod } from '#vendor/utils/routing/body-methods.js'
import type { Method } from '#vendor/types/types.js'

function isArkType(value: unknown): value is Type {
    if (value === null || value === undefined) return false
    if (typeof value !== 'object' && typeof value !== 'function') return false
    return 'expression' in value && 'json' in value && typeof value.expression === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSchemaField(value: unknown): value is SerializedSchemaField {
    return (
        isRecord(value) &&
        typeof value['name'] === 'string' &&
        typeof value['type'] === 'string' &&
        typeof value['required'] === 'boolean'
    )
}

const JSON_SCHEMA_KEYS = ['type', 'properties', 'anyOf', 'oneOf', 'allOf', '$ref', 'enum', 'const']

function isJsonSchema(value: unknown): value is Record<string, unknown> {
    return isRecord(value) && JSON_SCHEMA_KEYS.some((key) => key in value)
}

function jsonSchemaType(schema: unknown): string {
    if (!isRecord(schema)) return 'unknown'
    const { type } = schema
    if (typeof type === 'string') return type
    if (Array.isArray(type)) return type.filter((item) => typeof item === 'string').join(' | ')
    if ('const' in schema) return JSON.stringify(schema['const'])
    if (Array.isArray(schema['enum'])) {
        return schema['enum'].map((item) => JSON.stringify(item)).join(' | ')
    }
    return 'unknown'
}

// Top-level object properties only, like the `fields` summary of serializeArkSchema.
function jsonSchemaFields(schema: Record<string, unknown>): SerializedSchemaField[] {
    const { properties } = schema
    if (!isRecord(properties)) return []
    const required = Array.isArray(schema['required']) ? schema['required'] : []
    return Object.entries(properties).map(([name, property]) => ({
        name,
        type: jsonSchemaType(property),
        required: required.includes(name),
    }))
}

/**
 * Turns what `validator.describe()` returns into the doc schema shape. Accepted:
 * - an ArkType Type (the default adapter);
 * - a ready descriptor `{ expression: string, fields?, jsonSchema? }`, for an
 *   adapter that serializes its own schemas;
 * - a plain JSON Schema object (what most validation libraries can export).
 * Anything else (no describe(), a predicate validator) gives no schema; the route
 * itself is still serialized.
 */
function describeSchema(validator: unknown): SerializedArkSchema | undefined {
    const described = (validator as { describe?: () => unknown } | undefined)?.describe?.()

    if (isArkType(described)) return serializeArkSchema(described)

    if (isRecord(described) && typeof described['expression'] === 'string') {
        const fields = Array.isArray(described['fields'])
            ? described['fields'].filter(isSchemaField)
            : []
        return {
            expression: described['expression'],
            fields,
            ...(described['jsonSchema'] !== undefined
                ? { jsonSchema: described['jsonSchema'] }
                : {}),
        }
    }

    if (isJsonSchema(described)) {
        return {
            expression: jsonSchemaType(described),
            fields: jsonSchemaFields(described),
            jsonSchema: described,
        }
    }

    return undefined
}

type SerializedRouteItem = Record<string, unknown> & {
    handler: null
    validator: undefined
    queryValidator: undefined
    ResponseSchema: undefined
    inputSchema?: SerializedArkSchema
    /**
     * Query schema serialized separately from `inputSchema` so the api-playground
     * UI can render request body and query string as distinct sections.
     */
    querySchema?: SerializedArkSchema
    outputSchema?: SerializedArkSchema
    /**
     * Body size limit per allowed content type (the limit depends on the request
     * Content-Type, not on the route). Only routes that read a body have it;
     * `[]` means `allowedContentTypes: []` — no body type is allowed.
     */
    bodyLimits?: { kind: BodyKind; maxBytes: number }[]
}

/**
 * Serializes routes for the doc endpoint:
 * - Removes handler function references
 * - Extracts validator.describe() → inputSchema / querySchema { expression, fields[] }
 * - Extracts ArkType ResponseSchema → outputSchema { expression, fields[] }
 * - Adds bodyLimits for post/put/patch routes
 * - Supports unlimited nesting of groups
 */
export function serializeRoutes(routes: unknown[]): unknown[] {
    return routes.map((item: unknown) => {
        if (typeof item !== 'object' || item === null) return item
        const obj = item as Record<string, unknown>

        // Group container — recurse into nested routes
        if (Array.isArray(obj['group'])) {
            return {
                ...obj,
                validator: undefined,
                queryValidator: undefined,
                ResponseSchema: undefined,
                group: serializeRoutes(obj['group'] as unknown[]),
            }
        }

        // Route item — extract schema info and null out non-serializable fields
        const result: SerializedRouteItem = {
            ...obj,
            handler: null,
            validator: undefined,
            queryValidator: undefined,
            ResponseSchema: undefined,
        }

        // Validators are engine-neutral; describe() supplies the schema shown in the playground.
        const inputSchema = describeSchema(obj['validator'])
        if (inputSchema !== undefined) result.inputSchema = inputSchema

        const querySchema = describeSchema(obj['queryValidator'])
        if (querySchema !== undefined) result.querySchema = querySchema

        if (typeof obj['method'] === 'string' && isBodyMethod(obj['method'] as Method)) {
            // Same default as readAndParseBody.
            const allowed = (obj['allowedContentTypes'] as BodyKind[] | undefined) ?? ['json']
            // The route's own maxBodySize tightens the limit of every kind it accepts.
            const routeLimit =
                typeof obj['maxBodySize'] === 'number' ? obj['maxBodySize'] : undefined
            result.bodyLimits = allowed.map((kind) => ({
                kind,
                maxBytes: resolveMaxBodySize(kind, routeLimit),
            }))
        }

        if (isArkType(obj['ResponseSchema'])) {
            result.outputSchema = serializeArkSchema(obj['ResponseSchema'])
        }

        return result
    })
}
