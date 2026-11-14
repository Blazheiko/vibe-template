import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Not merged with vite.config.ts: that one resolves the addresses from the environment and
// renders pages on build; the tests pass addresses in themselves.
export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
        // A package-local module cache: the workspace-root one races with the other packages under `pnpm test`.
        fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
        environment: 'node',
        root: fileURLToPath(new URL('./', import.meta.url)),
        include: ['src/**/__tests__/*.spec.ts', 'build/**/__tests__/*.spec.ts'],
    },
})
