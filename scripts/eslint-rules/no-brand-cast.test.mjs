import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'

import rule from './no-brand-cast.mjs'

// A failure inside the TypeScript checker has a deep stack; keep all of it in the report.
Error.stackTraceLimit = Infinity

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const filename = `${fixtures}file.ts`

RuleTester.it = test
RuleTester.describe = (_name, fn) => fn()

const tester = new RuleTester({
    languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixtures },
    },
})

// The brand is declared in the tested code itself: importing it from a fixture module made the
// TypeScript checker of the CI runner fail to resolve the import (errorNoModuleMemberSymbol), and
// then throw while printing that error. A renamed import is the same symbol to the checker as an
// alias chain, which the cases below cover.
const header = [
    "declare const brandKey: ' brand'",
    'type Brand<T, Id> = T & { readonly [brandKey]: [T, Id] }',
    "type UserId = Brand<bigint, 'UserId'>",
    'type U = UserId',
    'type Row = { id: UserId; name: string }',
    'declare const x: bigint',
    'declare const row: unknown',
    'export {}',
    '',
].join('\n')
const valid = (code) => ({ code: header + code, filename })
const invalid = (code) => ({ code: header + code, filename, errors: [{ messageId: 'brandCast' }] })

tester.run('no-brand-cast', rule, {
    valid: [
        valid('const a = [1, 2] as const'),
        valid('const b = x as bigint'),
        valid("const c = 'a' as string"),
        valid('const d = row as Row'),
        valid('const e = row as unknown as Row'),
        valid('const f = row as { id: UserId }'),
    ],
    invalid: [
        invalid('const a = x as UserId'),
        invalid('const b = x as U'),
        invalid('type Alias = U\nconst c = x as Alias'),
        invalid('const d = (x as unknown) as UserId'),
        invalid('const e = <UserId>x'),
        invalid('const f = x as UserId | null'),
    ],
})
