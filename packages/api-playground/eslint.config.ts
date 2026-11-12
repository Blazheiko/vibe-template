import { globalIgnores } from 'eslint/config'
import {
    configureVueProject,
    defineConfigWithVueTs,
    vueTsConfigs,
} from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const monorepoRootDir = resolve(__dirname, '../..')

// The type-aware presets scan .vue files from rootDir (default: cwd). Pin it to this
// package so the root `pnpm lint` (cwd = repo root) sees the same files.
configureVueProject({ rootDir: __dirname })

export default defineConfigWithVueTs(
    {
        name: 'app/files-to-lint',
        files: ['**/*.{ts,mts,tsx,vue}'],
    },

    globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**', '**/*.js']),

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                extraFileExtensions: ['.vue'],
                tsconfigRootDir: monorepoRootDir,
            },
        },
    },

    pluginVue.configs['flat/essential'],
    vueTsConfigs.strictTypeChecked,
    vueTsConfigs.stylisticTypeChecked,
    {
        files: ['**/*.{ts,mts,tsx,vue}'],
        rules: {
            // Numbers in template literals format predictably.
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            // `||` on primitives is deliberate: '' (empty setting), 0 (no HTTP status) and
            // false (no search match) fall through to the next value; `??` would not.
            '@typescript-eslint/prefer-nullish-coalescing': [
                'error',
                { ignorePrimitives: { string: true, number: true, boolean: true } },
            ],
        },
    },
    {
        // Tests: no-op mocks and assertions on fixtures the test has just created.
        files: ['src/**/__tests__/**'],
        rules: {
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        // feat-193: a Vite config loads before the `shared-source` condition applies, so
        // `shared/*` there is shared/dist. Import the source by path (see frontend/vite.product.ts).
        files: ['vite.config.ts', 'vitest.config.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^shared(/|$)',
                            message:
                                'A Vite config reads shared/dist through the package name: import ../shared/src/<module>/index instead (feat-193).',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['eslint.config.ts', 'vite.sw.config.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                allowDefaultProject: true,
                tsconfigRootDir: monorepoRootDir,
            },
        },
    },
    skipFormatting,
)
