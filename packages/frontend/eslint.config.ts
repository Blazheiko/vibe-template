import pluginVue from 'eslint-plugin-vue'
import {
    configureVueProject,
    defineConfigWithVueTs,
    vueTsConfigs,
} from '@vue/eslint-config-typescript'
import pluginVitest from '@vitest/eslint-plugin'
import pluginPlaywright from 'eslint-plugin-playwright'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// To allow more languages other than `ts` in `.vue` files, uncomment the following lines:
// import { configureVueProject } from '@vue/eslint-config-typescript'
// configureVueProject({ scriptLangs: ['ts', 'tsx'] })
// More info at https://github.com/vuejs/eslint-config-typescript/#advanced-setup

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

    {
        name: 'app/files-to-ignore',
        ignores: ['**/dist/**', '**/dist-e2e-mock/**', '**/dist-ssr/**', '**/coverage/**'],
    },

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                extraFileExtensions: ['.vue'],
                tsconfigRootDir: monorepoRootDir,
            },
        },
    },

    {
        files: ['**/*.{ts,mts,tsx,vue}'],
        rules: {
            // Numbers in template literals format predictably.
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            // `||` on strings deliberately treats '' (empty env, empty API message) as missing.
            '@typescript-eslint/prefer-nullish-coalescing': [
                'error',
                { ignorePrimitives: { string: true } },
            ],
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@sentry/*'],
                            message: 'Import Sentry only from src/utils/sentry-service.ts',
                        },
                    ],
                },
            ],
        },
    },

    {
        files: ['src/utils/sentry-service.ts'],
        rules: {
            'no-restricted-imports': 'off',
        },
    },

    pluginVue.configs['flat/essential'],
    vueTsConfigs.strictTypeChecked,
    vueTsConfigs.stylisticTypeChecked,

    {
        // Tests: no-op mocks and assertions on fixtures the test has just created.
        files: ['src/**/__tests__/**', 'e2e/**', 'e2e-csp/**'],
        rules: {
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },

    {
        ...pluginVitest.configs.recommended,
        files: ['src/**/__tests__/*'],
    },

    {
        ...pluginPlaywright.configs['flat/recommended'],
        files: ['e2e/**/*.{test,spec}.{js,ts,jsx,tsx}', 'e2e-csp/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    },
    {
        files: ['src/types/i18n.d.ts'],
        rules: {
            '@typescript-eslint/no-empty-object-type': 'off',
        },
    },
    skipFormatting,
)
