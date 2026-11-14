import { globalIgnores } from 'eslint/config'
import {
    configureVueProject,
    defineConfigWithVueTs,
    vueTsConfigs,
} from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import pluginPlaywright from 'eslint-plugin-playwright'
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

    globalIgnores([
        '**/dist/**',
        '**/dist-ssr/**',
        '**/coverage/**',
        '**/playwright-report/**',
        '**/test-results/**',
        '**/*.js',
    ]),

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                extraFileExtensions: ['.vue'],
                tsconfigRootDir: monorepoRootDir,
            },
        },
    },

    pluginVue.configs['flat/recommended'],
    vueTsConfigs.strictTypeChecked,
    vueTsConfigs.stylisticTypeChecked,
    {
        files: ['**/*.{ts,mts,tsx,vue}'],
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        },
    },
    {
        // There is no client entry, so Vite never injects a component's <style> into the page:
        // styles live in src/styles/*.css, linked from index.html (docs/plan/landing-plan.md).
        files: ['src/**/*.vue'],
        rules: {
            'vue/no-restricted-block': [
                'error',
                {
                    element: 'style',
                    message:
                        'The landing has no client entry, so a <style> block never reaches the page: put the CSS in src/styles/.',
                },
            ],
        },
    },
    {
        // A Vite config loads before the `shared-source` condition applies, so `shared/*` there
        // is shared/dist (feat-193). The plugin modules under build/ are part of the config.
        files: ['vite.config.ts', 'vitest.config.ts', 'build/**/*.ts'],
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
        files: ['src/**/__tests__/**', 'build/**/__tests__/**', 'e2e/**'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        ...pluginPlaywright.configs['flat/recommended'],
        files: ['e2e/**/*.ts'],
    },
    {
        files: ['eslint.config.ts'],
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
