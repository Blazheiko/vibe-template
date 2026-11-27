import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

import { builtinModules } from 'node:module'

import noBrandCast from './scripts/eslint-rules/no-brand-cast.mjs'

// docs/adr/0005-route-contracts.md, 0006: a route of the application is declared through its
// contract (`defineRoute` of app/routes/contract-schemas). The schema-only helper is for the
// tests of the HTTP machinery (feat-170).
const ROUTE_CONTRACT_IMPORT_PATHS = [
    {
        name: '#app/routing/define-raw-route.js',
        message:
            'Declare the route through its contract: defineRoute from #app/routes/contract-schemas/index.js (ADR 0005).',
    },
    {
        name: '#app/routing/define-ws-route.js',
        message:
            'Declare the WS route through its contract: defineWsRoute from #app/routes/contract-schemas/index.js (ADR 0006).',
    },
]

// feat-275: Node built-ins only with the node: prefix ('node:crypto', not 'crypto').
const NODE_BUILTIN_IMPORT_PATHS = builtinModules
    .filter((name) => !name.startsWith('node:') && !name.startsWith('_'))
    .map((name) => ({
        name,
        message: `Import Node built-ins with the node: prefix: 'node:${name}'.`,
    }))

// packages/frontend, packages/api-playground and packages/landing have their own eslint.config.ts: ESLint 10
// lints each file with the nearest config, so blocks for those packages do not belong here.
export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/dist-e2e-mock/**',
            '**/dist-e2e-sentry/**',
            '**/node_modules/**',
            // local agent worktrees and settings (git-ignored): each worktree is a whole copy of
            // the repository and would be linted twice
            '.claude/**',
            // the SPA copied into the backend by scripts/prod-local.sh and the Dockerfile
            'packages/backend/public/**',
            '**/coverage/**',
            '**/generated/**',
            'documentation/.vitepress/cache/**',
            'eslint.config.ts',
            'packages/backend/vitest.config.ts',
            'packages/backend/vitest.redis.config.ts',
            'packages/backend/vitest.pg.config.ts',
            'packages/backend/drizzle.config.ts',
            // typed fixtures of the tests of the local rules (their own tsconfig)
            'scripts/eslint-rules/fixtures/**',
            // the type declaration of a local rule for the frontend's eslint.config.ts
            'scripts/eslint-rules/*.d.mts',
        ],
    },

    eslint.configs.recommended,

    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,

    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                extraFileExtensions: ['.vue'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/explicit-function-return-type': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-return': 'error',
            '@typescript-eslint/strict-boolean-expressions': [
                'error',
                {
                    allowString: false,
                    allowNumber: false,
                    allowNullableObject: false,
                },
            ],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
            '@typescript-eslint/consistent-type-exports': [
                'error',
                { fixMixedExportsWithInlineTypeSpecifier: true },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    {
        // ADR 0007 (feat-263): a branded type (UserId, PasskeyId, EntityId…) comes from its
        // constructor module or a schema, never from a cast in the code that uses it. The
        // constructor modules and the tests are the places that may cast.
        files: ['packages/backend/src/**/*.ts', 'packages/shared/src/**/*.ts'],
        ignores: [
            'packages/shared/src/brand/**',
            'packages/backend/src/database/ids.ts',
            'packages/backend/src/app/domain/**',
            'packages/backend/src/test-support/**',
            'packages/backend/**/*.spec.ts',
            'packages/backend/**/*.test.ts',
        ],
        plugins: { local: { rules: { 'no-brand-cast': noBrandCast } } },
        rules: { 'local/no-brand-cast': 'error' },
    },
    {
        // Plain JS (tests of `shared`, scripts, tool configs): the recommended rules, no type
        // information (there is no tsconfig for these files).
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: { globals: globals.node },
        rules: {
            // Type annotations belong to TypeScript.
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    {
        files: ['eslint.config.ts', 'packages/backend/vitest.config.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                allowDefaultProject: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // Backend tests: mocks and fixtures. Production backend code gets the full rule set.
        files: [
            'packages/backend/**/*.spec.ts',
            'packages/backend/**/*.test.ts',
            'packages/backend/src/test-support/**/*.ts',
        ],
        rules: {
            // Return types of test callbacks and mock factories add noise, not safety.
            '@typescript-eslint/explicit-function-return-type': 'off',
            // Partial fakes of uWS, drizzle and ioredis objects.
            '@typescript-eslint/no-explicit-any': 'off',
            // No-op mocks and async mocks that resolve immediately.
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/require-await': 'off',
            // Assertions on fixtures the test has just created.
            '@typescript-eslint/no-non-null-assertion': 'off',
            // Resetting env and mock registries between tests.
            '@typescript-eslint/no-dynamic-delete': 'off',
        },
    },
    {
        files: ['packages/backend/src/app/controllers/types/index.d.ts'],
        rules: {
            '@typescript-eslint/consistent-type-imports': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    {
        files: ['packages/backend/drizzle.config.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                allowDefaultProject: true,
            },
        },
    },
    // no-restricted-imports: a later block that sets the rule for the same file replaces its
    // options, it does not add to them. So every block below repeats the lists that apply to its
    // files (feat-275), and a new restriction goes into each block that covers the file.
    {
        // ADR 0005/0006 and node: built-ins (feat-275) for the backend, tests left out.
        files: ['packages/backend/src/**/*.ts'],
        ignores: [
            '**/*.spec.ts',
            '**/*.test.ts',
            'packages/backend/src/app/routing/define-raw-route.ts',
            'packages/backend/src/app/routing/define-ws-route.ts',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                { paths: [...ROUTE_CONTRACT_IMPORT_PATHS, ...NODE_BUILTIN_IMPORT_PATHS] },
            ],
        },
    },
    {
        // The two route helpers themselves: node: built-ins only.
        files: [
            'packages/backend/src/app/routing/define-raw-route.ts',
            'packages/backend/src/app/routing/define-ws-route.ts',
        ],
        rules: {
            'no-restricted-imports': ['error', { paths: NODE_BUILTIN_IMPORT_PATHS }],
        },
    },
    {
        // feat-275: inside vendor, imports go through #vendor/* (no ../) and the logger through
        // #vendor/utils/logger.js (#logger stays the alias of the rest of the backend). Repeats
        // the lists of the backend block above, see the note on no-restricted-imports.
        files: ['packages/backend/src/vendor/**/*.ts'],
        ignores: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        ...ROUTE_CONTRACT_IMPORT_PATHS,
                        ...NODE_BUILTIN_IMPORT_PATHS,
                        {
                            name: '#logger',
                            message:
                                'Inside vendor import the logger from #vendor/utils/logger.js.',
                        },
                    ],
                    patterns: [
                        {
                            regex: '^\\.\\./',
                            message: 'Inside vendor import through #vendor/* instead of ../.',
                        },
                    ],
                },
            ],
        },
    },
    {
        // feat-270 (plan Р7, T39): ioredis takes an expiry as a bare number, so EX seconds and
        // PX milliseconds mix up silently. App code sets an expiry through the typed helpers of
        // vendor/utils/redis/redis-ttl.ts. feat-272: the session layer in vendor/ too.
        files: ['packages/backend/src/**/*.ts'],
        ignores: [
            '**/*.spec.ts',
            '**/*.test.ts',
            'packages/backend/src/vendor/utils/redis/redis-ttl.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'CallExpression[callee.property.name=/^(setex|psetex|expire|pexpire|expireat|pexpireat|getex)$/]',
                    message:
                        'Set a Redis expiry through vendor/utils/redis/redis-ttl.ts: its helpers take Seconds or Milliseconds (plan Р7).',
                },
                {
                    selector:
                        "CallExpression[callee.property.name='set'] > Literal[value=/^(EX|PX|EXAT|PXAT)$/i]",
                    message:
                        'Set a Redis expiry through vendor/utils/redis/redis-ttl.ts: its helpers take Seconds or Milliseconds (plan Р7).',
                },
            ],
        },
    },
    {
        files: ['**/*.spec.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },
)
