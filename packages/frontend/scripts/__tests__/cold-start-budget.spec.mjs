import { describe, expect, it } from 'vitest'

import { coldStartFiles, forbiddenModules, heaviest, staticClosure } from '../cold-start-budget.mjs'

/** @returns {import('../cold-start-budget.mjs').BuildChunk} */
const chunk = (fileName, overrides = {}) => ({
    fileName,
    isEntry: false,
    imports: [],
    importedCss: [],
    facadeModuleId: null,
    moduleIds: [],
    ...overrides,
})

// entry -> vendor (static); entry -> route (dynamic, not listed in `imports`);
// uk.ts is its own chunk that imports the vendor; en.ts sits in the entry.
const build = [
    chunk('index.js', {
        isEntry: true,
        imports: ['vendor.js'],
        importedCss: ['index.css'],
        moduleIds: ['/app/src/main.ts', '/app/src/locales/en.ts'],
    }),
    chunk('vendor.js', {
        moduleIds: ['/app/node_modules/vue/index.js'],
        importedCss: ['vendor.css'],
    }),
    chunk('route.js', { importedCss: ['route.css'], moduleIds: ['/app/src/views/Route.vue'] }),
    chunk('uk.js', {
        imports: ['vendor.js'],
        facadeModuleId: '/app/src/locales/uk.ts',
        moduleIds: ['/app/src/locales/uk.ts'],
    }),
]

describe('cold-start budget', () => {
    it('follows static imports only, once each', () => {
        const chunks = new Map(build.map((item) => [item.fileName, item]))
        expect(staticClosure(chunks, 'index.js').map((item) => item.fileName)).toEqual([
            'index.js',
            'vendor.js',
        ])
    })

    it('counts the entry graph and the CSS of its chunks, never a lazy chunk', () => {
        const en = coldStartFiles(build, ['en']).get('en')
        expect(en?.js).toEqual(['index.js', 'vendor.js'])
        expect(en?.css).toEqual(['index.css', 'vendor.css'])
    })

    it('adds the chunk of a lazily loaded locale without counting a shared chunk twice', () => {
        const uk = coldStartFiles(build, ['uk']).get('uk')
        expect(uk?.js).toEqual(['index.js', 'vendor.js', 'uk.js'])
    })

    it('fails when a locale is neither in the entry graph nor a chunk', () => {
        expect(() => coldStartFiles(build, ['pl'])).toThrow(/locale pl/)
    })

    it('reports a forbidden package once per kind', () => {
        const ids = [
            '/a/node_modules/@sentry/core/x.js',
            '/a/node_modules/@sentry/vue/y.js',
            '/a/src/b.ts',
        ]
        expect(forbiddenModules(ids, [{ pattern: /@sentry[\\/]/, why: 'Sentry' }])).toEqual([
            { why: 'Sentry', example: '/a/node_modules/@sentry/core/x.js', count: 2 },
        ])
    })

    it('checks the budget against the heaviest locale', () => {
        expect(
            heaviest(
                new Map([
                    ['en', 10],
                    ['uk', 12],
                    ['pl', 11],
                ]),
            ),
        ).toEqual({ locale: 'uk', bytes: 12 })
    })
})
