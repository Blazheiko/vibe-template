// Proves on the module graph of the production build that the browser bundle carries no
// validation schema and no validator library (docs/adr/0005-route-contracts.md, decision 1).
//
// A route contract from `shared/contracts` is `{ method, path }` at run time; its types come
// from the schemas through `import type`. One value import of a schema in the frontend would
// pull `shared/schemas`, `shared/responses` and ArkType into the bundle. The size of the bundle
// or a search of the minified code does not show that reliably; the list of modules Rollup
// actually bundled does.
//
// Usage: node scripts/check-bundle-graph.mjs   (from packages/frontend; shared must be built)
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

const FORBIDDEN = [
    {
        pattern: /[\\/]node_modules[\\/](\.pnpm[\\/])?@ark(type)?[+\\/]/,
        why: 'the validator library (ArkType)',
    },
    {
        pattern: /[\\/]node_modules[\\/](\.pnpm[\\/])?arktype[@\\/]/,
        why: 'the validator library (ArkType)',
    },
    { pattern: /[\\/]shared[\\/]dist[\\/]schemas[\\/]/, why: 'a request schema of shared/schemas' },
    {
        pattern: /[\\/]shared[\\/]dist[\\/]responses[\\/]/,
        why: 'a response schema of shared/responses',
    },
]

let moduleIds = []
await build({
    root,
    logLevel: 'silent',
    build: { write: false },
    plugins: [
        {
            name: 'collect-module-graph',
            generateBundle() {
                moduleIds = [...this.getModuleIds()]
            },
        },
    ],
})

const found = moduleIds.flatMap((id) =>
    FORBIDDEN.filter(({ pattern }) => pattern.test(id)).map(({ why }) => ({ id, why })),
)

if (moduleIds.length === 0) {
    console.error('check-bundle-graph: the build reported no modules; the check did not run.')
    process.exit(1)
}
if (found.length > 0) {
    console.error('check-bundle-graph: the frontend bundle contains server-side validation code:')
    // One line per kind with an example: a single schema import brings hundreds of modules.
    for (const why of new Set(found.map((item) => item.why))) {
        const ofKind = found.filter((item) => item.why === why)
        console.error(`  ${why}: ${String(ofKind.length)} modules, e.g. ${ofKind[0].id}`)
    }
    console.error(
        'Import schemas with `import type`; take the method and path from shared/contracts.',
    )
    process.exit(1)
}
console.log(
    `check-bundle-graph: ${String(moduleIds.length)} modules, no schema and no validator library.`,
)
