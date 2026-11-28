// The pure part of check-cold-start-budget.mjs: which files of a production build the browser
// loads before the first render of /login, and how much they weigh (feat-278, T2).
//
// The cold start is the entry chunk of index.html with everything it imports statically (the
// browser preloads those) and their CSS, plus the chunk of the interface locale: `en` is a
// static import of plugins/i18n.ts, `uk` and `pl` are loaded by useLocale before the app mounts.
// A dynamic import (a lazy route, a modal opened later) is not part of it.

/**
 * @typedef {object} BuildChunk
 * @property {string} fileName
 * @property {boolean} isEntry
 * @property {string[]} imports static imports (file names)
 * @property {string[]} importedCss CSS file names the chunk needs
 * @property {string | null} facadeModuleId
 * @property {string[]} moduleIds the modules bundled into the chunk
 */

/**
 * The chunks reachable from `start` through static imports, `start` included.
 *
 * @param {Map<string, BuildChunk>} chunks by file name
 * @param {string} start
 * @returns {BuildChunk[]}
 */
export function staticClosure(chunks, start) {
    const seen = new Set()
    const order = []
    const visit = (fileName) => {
        if (seen.has(fileName)) return
        seen.add(fileName)
        const chunk = chunks.get(fileName)
        if (chunk === undefined) throw new Error(`no chunk ${fileName} in the build`)
        order.push(chunk)
        for (const imported of chunk.imports) visit(imported)
    }
    visit(start)
    return order
}

const LOCALE_MODULE = /[\\/]src[\\/]locales[\\/]([a-z]{2})\.ts$/

/**
 * The files of the cold start for each locale.
 *
 * @param {BuildChunk[]} chunkList every JS chunk of the build
 * @param {string[]} locales the shipped locale codes
 * @returns {Map<string, { js: string[]; css: string[]; moduleIds: string[] }>}
 */
export function coldStartFiles(chunkList, locales) {
    const chunks = new Map(chunkList.map((chunk) => [chunk.fileName, chunk]))
    const entries = chunkList.filter((chunk) => chunk.isEntry)
    if (entries.length !== 1) {
        throw new Error(`expected one entry chunk, found ${String(entries.length)}`)
    }
    const base = staticClosure(chunks, entries[0].fileName)
    const baseModules = new Set(base.flatMap((chunk) => chunk.moduleIds))

    const result = new Map()
    for (const locale of locales) {
        const inBase = [...baseModules].some((id) => LOCALE_MODULE.exec(id)?.[1] === locale)
        const localeChunk = chunkList.find(
            (chunk) =>
                chunk.facadeModuleId !== null &&
                LOCALE_MODULE.exec(chunk.facadeModuleId)?.[1] === locale,
        )
        if (!inBase && localeChunk === undefined) {
            throw new Error(`locale ${locale} is neither in the entry graph nor a chunk of its own`)
        }
        const files = [...base]
        if (!inBase && localeChunk !== undefined) {
            for (const chunk of staticClosure(chunks, localeChunk.fileName)) {
                if (!files.includes(chunk)) files.push(chunk)
            }
        }
        result.set(locale, {
            js: files.map((chunk) => chunk.fileName),
            css: [...new Set(files.flatMap((chunk) => chunk.importedCss))],
            moduleIds: files.flatMap((chunk) => chunk.moduleIds),
        })
    }
    return result
}

/**
 * Packages that must stay out of the cold start (each feature that moves one out adds it).
 *
 * @type {{ pattern: RegExp; why: string }[]}
 */
export const FORBIDDEN_IN_COLD_START = []

/**
 * The forbidden modules found among `moduleIds`, one example per kind.
 *
 * @param {string[]} moduleIds
 * @param {{ pattern: RegExp; why: string }[]} forbidden
 * @returns {{ why: string; example: string; count: number }[]}
 */
export function forbiddenModules(moduleIds, forbidden = FORBIDDEN_IN_COLD_START) {
    return forbidden.flatMap(({ pattern, why }) => {
        const hits = moduleIds.filter((id) => pattern.test(id))
        return hits.length === 0 ? [] : [{ why, example: hits[0], count: hits.length }]
    })
}

/**
 * The heaviest locale: the budget is checked against it.
 *
 * @param {Map<string, number>} totals gzip bytes by locale
 * @returns {{ locale: string; bytes: number }}
 */
export function heaviest(totals) {
    let max = { locale: '', bytes: -1 }
    for (const [locale, bytes] of totals) if (bytes > max.bytes) max = { locale, bytes }
    return max
}
