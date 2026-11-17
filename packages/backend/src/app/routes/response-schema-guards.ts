import type { BaseType } from '@arktype/type'

// Walks the JSON form of an ArkType schema and returns the paths whose content the
// schema does not describe (`unknown` → `{}`, `unknown[]` → `"Array"`): an allow-list
// cannot filter them (docs/plan/archive/strip-response-fields-plan.md §4.5).
type Node = unknown

const isRecord = (value: Node): value is Record<string, Node> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const walk = (node: Node, path: string, out: Set<string>): void => {
    if (Array.isArray(node)) {
        for (const branch of node) walk(branch, path, out)
        return
    }
    if (node === 'Array') {
        out.add(`${path}[]`)
        return
    }
    if (!isRecord(node)) return
    if (Object.keys(node).length === 0) {
        out.add(path)
        return
    }
    if (node['proto'] === 'Array' && node['sequence'] === undefined) {
        out.add(`${path}[]`)
        return
    }
    if (node['sequence'] !== undefined) walk(node['sequence'], `${path}[]`, out)
    for (const group of ['required', 'optional'] as const) {
        const props = node[group]
        if (!Array.isArray(props)) continue
        for (const prop of props) {
            if (isRecord(prop) && typeof prop['key'] === 'string') {
                walk(prop['value'], path === '' ? prop['key'] : `${path}.${prop['key']}`, out)
            }
        }
    }
    if (node['branches'] !== undefined) walk(node['branches'], path, out)
}

export const unknownPaths = (schema: BaseType): string[] => {
    const out = new Set<string>()
    walk(schema.json, '', out)
    return [...out].sort()
}

// Paths whose type JSON does not keep (feat-047): `Date` becomes an ISO string and `bigint`
// a string in makeJson, so a schema with them does not describe what the client gets.
const walkNonWire = (node: Node, path: string, out: Set<string>): void => {
    if (Array.isArray(node)) {
        for (const branch of node) walkNonWire(branch, path, out)
        return
    }
    if (node === 'bigint' || node === 'Date') {
        out.add(`${path}: ${node}`)
        return
    }
    if (!isRecord(node)) return
    if (node['proto'] === 'Date') out.add(`${path}: Date`)
    if (node['domain'] === 'bigint') out.add(`${path}: bigint`)
    if (node['sequence'] !== undefined) walkNonWire(node['sequence'], `${path}[]`, out)
    if (node['branches'] !== undefined) walkNonWire(node['branches'], path, out)
    for (const group of ['required', 'optional'] as const) {
        const props = node[group]
        if (!Array.isArray(props)) continue
        for (const prop of props) {
            if (isRecord(prop) && typeof prop['key'] === 'string') {
                walkNonWire(
                    prop['value'],
                    path === '' ? prop['key'] : `${path}.${prop['key']}`,
                    out,
                )
            }
        }
    }
}

export const nonWirePaths = (schema: BaseType): string[] => {
    const out = new Set<string>()
    walkNonWire(schema.json, '', out)
    return [...out].sort()
}
