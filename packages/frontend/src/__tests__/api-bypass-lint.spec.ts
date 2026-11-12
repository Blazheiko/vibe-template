// @vitest-environment node
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

// feat-186: the frontend calls the API only through its contracts (ADR 0005, 0006). The ESLint
// rules in eslint.config.ts are what keeps it so; this runs them, with the package's real config,
// on code that goes around the clients, and on code that does not. The samples are linted as if
// they were src/utils/api-path.ts: a file of the package that no rule exempts.

const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const sampleFile = fileURLToPath(new URL('../utils/api-path.ts', import.meta.url))

let eslint: ESLint
// The first lint builds the TypeScript program of the package (type-aware rules): seconds on a
// busy machine. Done once here, with its own timeout, so the cases below stay quick.
beforeAll(async () => {
    eslint = new ESLint({ cwd: packageDir })
    await eslint.lintText('export {}\n', { filePath: sampleFile })
}, 60_000)

/** The ids of the rules a sample breaks. */
const brokenRules = async (code: string): Promise<string[]> => {
    const results = await eslint.lintText(code, { filePath: sampleFile })
    return results.flatMap((result) =>
        result.messages.map((message) => message.ruleId ?? 'parse-error'),
    )
}

describe('ESLint keeps API calls on their contracts', () => {
    it.each([
        [
            'the transport under its own name',
            "import baseApi from './base-api'\nexport const used = baseApi",
        ],
        [
            'the transport under another name',
            "import transport from './base-api'\nexport const used = transport",
        ],
        [
            'the transport through the alias',
            "import t from '@/utils/base-api'\nexport const used = t",
        ],
        [
            'the whole transport module',
            "import * as transport from './base-api'\nexport const used = transport",
        ],
        // feat-187: the same module with an extension.
        ['the transport with .ts', "import t from './base-api.ts'\nexport const used = t"],
        ['the transport with .js', "import t from '@/utils/base-api.js'\nexport const used = t"],
        ['the transport with .mjs', "import t from './base-api.mjs'\nexport const used = t"],
    ])('refuses %s', async (_name, code) => {
        expect(await brokenRules(code)).toContain('no-restricted-imports')
    })

    it.each([
        ['fetch', "void fetch('/api/main/init')"],
        ['window.fetch', "void window.fetch('/api/main/init')"],
        ['globalThis.fetch', "void globalThis.fetch('/api/main/init')"],
    ])('refuses a hand-written %s', async (_name, code) => {
        const rules = await brokenRules(code)
        expect(
            rules.some((rule) =>
                ['no-restricted-globals', 'no-restricted-properties'].includes(rule),
            ),
        ).toBe(true)
    })

    it.each(["'./base-api'", "'./base-api.ts'", "'@/utils/base-api.js'"])(
        'refuses a dynamic import of the transport, %s',
        async (source) => {
            expect(await brokenRules(`void import(${source})`)).toContain('no-restricted-syntax')
        },
    )

    it('does not take another module whose name ends alike for the transport', async () => {
        expect(
            await brokenRules(
                "import t from './my-base-api'\nimport u from './base-api-docs.ts'\nexport const used = [t, u]",
            ),
        ).not.toContain('no-restricted-imports')
    })

    it('lets the named settings of the transport through, and the clients', async () => {
        expect(
            await brokenRules(
                [
                    "import { setCurrentUserIdProvider } from './base-api'",
                    "import { callApi } from './api-client'",
                    'export const used = [setCurrentUserIdProvider, callApi]',
                ].join('\n'),
            ),
        ).toEqual([])
    })
})
