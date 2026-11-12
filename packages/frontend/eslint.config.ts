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

// Restricted imports, one list per file group: a later block's `no-restricted-imports` replaces
// an earlier one, so each block names every pattern that still applies to its files.
const SENTRY_ONLY_IN_SERVICE = {
    group: ['@sentry/*'],
    message: 'Import Sentry only from src/utils/sentry-service.ts',
}
// feat-186: the transport is reached through the clients, under any name. Its named settings
// (setCurrentUserIdProvider, setReloadHandler) stay importable.
const TRANSPORT_ONLY_IN_CLIENT = {
    group: ['**/base-api', '@/utils/base-api'],
    importNames: ['default'],
    message:
        'Call the API through a contract: callApi(contract, input) from @/utils/api-client (ADR 0005).',
}

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
                { patterns: [SENTRY_ONLY_IN_SERVICE, TRANSPORT_ONLY_IN_CLIENT] },
            ],
        },
    },

    {
        files: ['src/utils/sentry-service.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [TRANSPORT_ONLY_IN_CLIENT] }],
        },
    },

    {
        // The HTTP client is the one module that holds the transport; tests drive it directly.
        files: ['src/utils/api-client.ts', 'src/**/__tests__/**'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [SENTRY_ONLY_IN_SERVICE] }],
        },
    },

    {
        // feat-186: no request by hand. The transport (base-api.ts) is the one place that calls
        // fetch for the API; the service worker fetches for its cache.
        files: ['src/**/*.{ts,vue}'],
        ignores: ['src/utils/base-api.ts', 'src/service-worker.ts', 'src/**/__tests__/**'],
        rules: {
            'no-restricted-globals': [
                'error',
                {
                    name: 'fetch',
                    message:
                        'Call the API through a contract: callApi(contract, input) from @/utils/api-client (ADR 0005).',
                },
            ],
            'no-restricted-properties': [
                'error',
                ...['window', 'globalThis', 'self'].map((object) => ({
                    object,
                    property: 'fetch',
                    message:
                        'Call the API through a contract: callApi(contract, input) from @/utils/api-client (ADR 0005).',
                })),
            ],
        },
    },

    {
        // The API is called through contracts, never by hand:
        // - HTTP through `callApi` in utils/api-client.ts (docs/adr/0005-route-contracts.md,
        //   feat-170);
        // - WS requests through `callWs` in utils/ws-client.ts, on top of the connection in
        //   composables/useWebSocketConnection.ts (docs/adr/0006-websocket-contracts.md, feat-181).
        // One block on purpose: a second block with `no-restricted-syntax` for the same files
        // would replace this one, not add to it.
        files: ['src/**/*.{ts,vue}'],
        ignores: [
            'src/utils/api-client.ts',
            'src/utils/ws-client.ts',
            'src/composables/useWebSocketConnection.ts',
            'src/**/__tests__/**',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'CallExpression[callee.property.name=/^(http|upload)$/][callee.object.name=/^(baseApi|api)$/]',
                    message:
                        'Call the API through a contract: callApi(contract, input) from @/utils/api-client (ADR 0005).',
                },
                {
                    // feat-186: the transport cannot be reached by a dynamic import either.
                    selector: 'ImportExpression[source.value=/base-api$/]',
                    message:
                        'Call the API through a contract: callApi(contract, input) from @/utils/api-client (ADR 0005).',
                },
                {
                    selector:
                        "CallExpression:matches([callee.name='websocketApi'], [callee.property.name='websocketApi'])",
                    message:
                        'Send the WS request through its contract: callWs(contract, payload) from @/utils/ws-client (ADR 0006).',
                },
            ],
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
