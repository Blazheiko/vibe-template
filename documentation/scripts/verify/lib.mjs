// Pure helpers for verify-dist.mjs. No filesystem access here, so everything is unit-testable.

import path from 'node:path'

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const INCLUDE_RE = /<!--\s*@include:\s*([^\s]+?)\s*-->/g
const ASSET_EXT_RE = /\.[a-z0-9]+$/i

/** Normalise text for comparisons: drop zero-width chars, collapse whitespace. */
export function normalizeText(text) {
    return text
        .replace(/[\u200b\u00a0]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/** Strip inline Markdown so a source line can be compared with rendered text. */
export function stripInlineMarkdown(line) {
    return normalizeText(
        line
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/`([^`]*)`/g, '$1')
            .replace(/(\*\*|__)(.*?)\1/g, '$2')
            .replace(/(\*|_)(.*?)\1/g, '$2')
            .replace(/<[^>]+>/g, ''),
    )
}

/**
 * Classify a URL found in a src/href/srcset attribute.
 * Returns 'skip' (external, special scheme or same-page #anchor) or 'internal'.
 */
export function classifyUrl(url) {
    const value = url.trim()
    if (value === '' || value.startsWith('#')) return 'skip'
    if (value.startsWith('//')) return 'skip'
    if (SCHEME_RE.test(value)) return 'skip'
    return 'internal'
}

/**
 * Resolve an internal URL against the page it appears on.
 * Returns { kind: 'asset' | 'page', file, candidates, hash } or { error }.
 * `file`/`candidates` are paths relative to dist without a leading slash.
 */
export function resolveInternalUrl(url, pageUrlPath, base) {
    const resolved = new URL(url, `http://local${pageUrlPath}`)
    const pathname = decodeURIComponent(resolved.pathname)
    const hash = resolved.hash ? decodeURIComponent(resolved.hash.slice(1)) : ''

    if (!pathname.startsWith(base)) {
        return { error: `does not start with base "${base}"` }
    }
    const rel = pathname.slice(base.length)

    if (rel.endsWith('.html')) return { kind: 'page', candidates: [rel], hash }
    if (ASSET_EXT_RE.test(rel)) return { kind: 'asset', file: rel, hash }
    if (rel === '' || rel.endsWith('/'))
        return { kind: 'page', candidates: [`${rel}index.html`], hash }
    return { kind: 'page', candidates: [`${rel}.html`, `${rel}/index.html`], hash }
}

/** Split a srcset attribute into its URLs. */
export function srcsetUrls(srcset) {
    return srcset
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter((part) => part !== undefined && part !== '')
}

/** Find `<!--@include: path-->` directives. Returns raw path, file path and selector suffix. */
export function extractIncludes(markdown) {
    const includes = []
    for (const match of markdown.matchAll(INCLUDE_RE)) {
        const raw = match[1]
        // VitePress allows `file.md#region` and `file.md{3-10}` suffixes.
        const file = raw.replace(/\{[^}]*\}$/, '').replace(/#[^/]*$/, '')
        includes.push({ raw, file, partial: file !== raw })
    }
    return includes
}

/** Count ```mermaid fences. */
export function countMermaidBlocks(markdown) {
    return (markdown.match(/^\s*(```|~~~)mermaid\b/gm) ?? []).length
}

/**
 * Derive include markers from an included Markdown file: its first heading and the first
 * plain text paragraph line that is not a heading, fence, list, table, quote or HTML.
 */
export function deriveMarkers(markdown) {
    const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
    let heading
    let text
    let inFence = false
    for (const rawLine of lines) {
        const line = rawLine.trim()
        if (/^(```|~~~)/.test(line)) {
            inFence = !inFence
            continue
        }
        if (inFence || line === '') continue
        const headingMatch = /^#{1,6}\s+(.*)$/.exec(line)
        if (headingMatch) {
            heading ??= stripInlineMarkdown(headingMatch[1].replace(/\s*\{#[^}]*\}\s*$/, ''))
            continue
        }
        if (/^([-*+]\s|\d+\.\s|\||>|<|:::|!\[)/.test(line)) continue
        text ??= stripInlineMarkdown(line)
        if (heading !== undefined && text !== undefined) break
    }
    return { heading, text }
}

/** Map a source Markdown path (relative to srcDir) to its dist HTML file and URL path. */
export function markdownToDist(mdRelPath, base) {
    const noExt = mdRelPath.replace(/\.md$/, '')
    const html = `${noExt}.html`
    let urlPath
    if (noExt === 'index') urlPath = base
    else if (noExt.endsWith('/index')) urlPath = `${base}${noExt.slice(0, -'index'.length)}`
    else urlPath = `${base}${noExt}`
    return { html, urlPath }
}

/** Repo-relative POSIX paths from `files` that match none of the workflow `paths` globs. */
export function uncoveredPaths(files, patterns) {
    return files.filter((file) => !patterns.some((p) => path.posix.matchesGlob(file, p)))
}

/** Collect the `paths` filters of the pull_request and push triggers of a parsed workflow. */
export function workflowPaths(workflow) {
    const on = workflow?.on ?? {}
    const pr = on.pull_request?.paths ?? []
    const push = on.push?.paths ?? []
    return { pr, push }
}
