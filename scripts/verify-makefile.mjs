// Keeps the Makefile a thin, self-documented layer over pnpm scripts (`make verify-makefile`,
// part of `make check`). Fails when:
// - a target has no `## description`, so `make help` would not show it;
// - a target is missing from .PHONY, or .PHONY names a target that does not exist;
// - a recipe calls `$(PNPM) [--filter <pkg>] <script>` and that script does not exist;
// - a recipe runs a file from scripts/ that does not exist.
//
// Usage: node scripts/verify-makefile.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PNPM_BUILTINS = new Set(['install'])

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'))
}

// Root scripts under '', workspace packages under their package.json name.
function packageScripts() {
    const byName = new Map([['', readJson(join(root, 'package.json')).scripts ?? {}]])
    const dirs = readdirSync(join(root, 'packages')).map((dir) => join('packages', dir))
    for (const dir of [...dirs, 'documentation']) {
        const file = join(root, dir, 'package.json')
        if (!existsSync(file)) continue
        const pkg = readJson(file)
        byName.set(pkg.name, pkg.scripts ?? {})
    }
    return byName
}

function parseMakefile(text) {
    const lines = text.replace(/\\\n/g, ' ').split('\n')
    const targets = []
    const phony = new Set()
    let current = null
    for (const line of lines) {
        const phonyMatch = /^\.PHONY:(.*)$/.exec(line)
        if (phonyMatch !== null) {
            for (const name of phonyMatch[1].trim().split(/\s+/)) phony.add(name)
            continue
        }
        const rule = /^([a-z0-9-]+):(?!=)(.*)$/.exec(line)
        if (rule !== null) {
            const description = /##\s*(.+)$/.exec(rule[2])
            current = { name: rule[1], description: description?.[1] ?? null, recipe: [] }
            targets.push(current)
            continue
        }
        if (line.startsWith('\t') && current !== null) current.recipe.push(line.trim())
        else if (line.trim() !== '' && !line.startsWith('#')) current = null
    }
    return { targets, phony }
}

function verify() {
    const { targets, phony } = parseMakefile(readFileSync(join(root, 'Makefile'), 'utf8'))
    const scripts = packageScripts()
    const errors = []
    const names = new Set(targets.map((t) => t.name))

    for (const target of targets) {
        if (target.description === null) errors.push(`${target.name}: no "## description"`)
        if (!phony.has(target.name)) errors.push(`${target.name}: missing from .PHONY`)
        for (const line of target.recipe) {
            const call =
                /\$\(PNPM\)\s+(?:\$\(if [^)]*\)\s*)?(?:--filter\s+(\S+)\s+)?([\w:-]+)/.exec(line)
            if (call !== null) {
                const [, pkg = '', script] = call
                const known = scripts.get(pkg)
                if (known === undefined) errors.push(`${target.name}: unknown package "${pkg}"`)
                else if (!(script in known) && !(pkg === '' && PNPM_BUILTINS.has(script))) {
                    errors.push(`${target.name}: no script "${script}" in ${pkg || 'root'}`)
                }
            }
            for (const [file] of line.matchAll(/scripts\/[\w.-]+/g)) {
                if (!existsSync(join(root, file))) errors.push(`${target.name}: ${file} not found`)
            }
        }
    }
    for (const name of phony) {
        if (!names.has(name)) errors.push(`.PHONY: no target "${name}"`)
    }
    return { errors, count: targets.length }
}

const { errors, count } = verify()
if (errors.length > 0) {
    for (const error of errors) console.error(`verify-makefile: ${error}`)
    process.exit(1)
}
console.log(`verify-makefile: ${count} targets OK`)
