import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Dev servers resolve `shared` with the `shared-source` condition (frontend and playground Vite,
// backend `tsx watch --conditions`), so a change in src/ shows up without rebuilding. Everything
// else (start, Docker, typecheck, tests, vite build) has no such condition and stays on dist/.
const CONDITION = 'shared-source'
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const entries = Object.entries(pkg.exports)

test('every export resolves to src/ first under the shared-source condition', () => {
    assert.ok(entries.length > 0)
    for (const [subpath, target] of entries) {
        // Condition order is significant: a key after `import` would never be picked.
        assert.equal(Object.keys(target)[0], CONDITION, subpath)
        const source = target[CONDITION]
        assert.match(source, /^\.\/src\/.+\.ts$/, subpath)
        assert.ok(existsSync(new URL(source, `file://${pkgDir}`)), `${subpath}: ${source}`)
    }
})

test('the source entry mirrors the dist entry of the same subpath', () => {
    for (const [subpath, target] of entries) {
        const fromDist = target.import.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')
        assert.equal(target[CONDITION], fromDist, subpath)
        assert.match(target.import, /^\.\/dist\/.+\.js$/, subpath)
        assert.match(target.types, /^\.\/dist\/.+\.d\.ts$/, subpath)
    }
})
