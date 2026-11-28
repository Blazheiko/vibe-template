// The cold-start budget of the app (feat-278, T2): the gzip size of the JS and CSS the browser
// loads before the first render of /login, for the heaviest interface locale. A change that
// moves code into another statically imported file does not improve this number; only code
// that leaves the cold start does.
//
// The script builds the app itself, in memory (`write: false`), so it never measures a stale
// dist/. Every measurement of the frontend plan (docs/plan/frontend-tasks.md: T2, T7, T17,
// T21, T26) is taken with this script, so before and after are counted the same way.
//
// Usage: node scripts/check-cold-start-budget.mjs   (from packages/frontend; shared must be built)
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { build } from 'vite'
import { SHIPPED_LOCALE_CODES } from 'shared/enums'

import { coldStartFiles, forbiddenModules, heaviest } from './cold-start-budget.mjs'

// The budget, gzip bytes. Set from the measurement of the build it guards plus about 2 %
// headroom; lower it whenever a change shrinks the cold start (see the history in
// docs/plan/frontend-tasks.md and feature-state/<feat-id>/progress.md).
// 2026-11-28, main cf70b43d, before feat-278: en 331 054, uk 340 156, pl 339 199 (max uk).
// feat-278, lazy routes and avatar editor: en 277 636, uk 286 846, pl 285 872 (max uk).
const BUDGET_BYTES = 293_000

const root = fileURLToPath(new URL('..', import.meta.url))

/** @type {import('./cold-start-budget.mjs').BuildChunk[]} */
const chunkList = []
/** @type {Map<string, number>} */
const gzipBytes = new Map()

await build({
    root,
    logLevel: 'silent',
    build: { write: false },
    plugins: [
        {
            name: 'collect-cold-start',
            enforce: 'post',
            generateBundle(_options, bundle) {
                for (const output of Object.values(bundle)) {
                    if (output.type === 'chunk') {
                        chunkList.push({
                            fileName: output.fileName,
                            isEntry: output.isEntry,
                            imports: output.imports,
                            importedCss: [...(output.viteMetadata?.importedCss ?? [])],
                            facadeModuleId: output.facadeModuleId,
                            moduleIds: output.moduleIds,
                        })
                        gzipBytes.set(output.fileName, gzipSync(output.code).length)
                    } else if (output.fileName.endsWith('.css')) {
                        gzipBytes.set(output.fileName, gzipSync(output.source).length)
                    }
                }
            },
        },
    ],
})

if (chunkList.length === 0) {
    console.error('check-cold-start-budget: the build reported no chunks; the check did not run.')
    process.exit(1)
}

const files = coldStartFiles(chunkList, [...SHIPPED_LOCALE_CODES])
const sizeOf = (fileName) => gzipBytes.get(fileName) ?? 0
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

/** @type {Map<string, number>} */
const totals = new Map()
for (const [locale, { js, css }] of files) {
    const jsBytes = js.reduce((sum, name) => sum + sizeOf(name), 0)
    const cssBytes = css.reduce((sum, name) => sum + sizeOf(name), 0)
    totals.set(locale, jsBytes + cssBytes)
    console.log(
        `  ${locale}: JS ${kb(jsBytes)} (${String(js.length)} files) + CSS ${kb(cssBytes)} = ${kb(jsBytes + cssBytes)} (${String(jsBytes + cssBytes)} B)`,
    )
}

let failed = false
const allModuleIds = [...files.values()].flatMap((entry) => entry.moduleIds)
for (const { why, example, count } of forbiddenModules(allModuleIds)) {
    console.error(
        `check-cold-start-budget: ${why} is in the cold start (${String(count)} modules, e.g. ${example})`,
    )
    failed = true
}

const max = heaviest(totals)
if (max.bytes > BUDGET_BYTES) {
    console.error(
        `check-cold-start-budget: /login (${max.locale}) needs ${String(max.bytes)} B gzip, over the budget of ${String(BUDGET_BYTES)} B.`,
    )
    console.error('Load the new code lazily (a dynamic import), or raise the budget on purpose.')
    for (const name of files.get(max.locale)?.js ?? [])
        console.error(`    ${name}  ${kb(sizeOf(name))}`)
    failed = true
}

if (failed) process.exit(1)
console.log(
    `check-cold-start-budget: /login max ${kb(max.bytes)} (${max.locale}), budget ${kb(BUDGET_BYTES)}.`,
)
