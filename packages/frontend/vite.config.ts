import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

import { buildMeta } from './vite.build-meta'
import { stripConsoleLogs } from './vite.console'
import { sharedSource } from './vite.shared-source'

// Dev proxy for the backend's API_PATH_PREFIX, not a hard-coded /api (code-issues item 73).
// An object config (vitest.config.ts merges it), so the dev-mode env is read here.
const env = loadEnv('development', process.cwd(), 'VITE_')
const apiPrefix =
    ((env.VITE_API_PATH_PREFIX as string | undefined) ?? '').trim().replace(/^\/+|\/+$/g, '') ||
    'api'

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        vue({
            template: {
                compilerOptions: {
                    isCustomElement: (tag) => tag === 'pwa-install',
                },
            },
        }),
        vueDevTools(),
        buildMeta(),
        sharedSource(),
    ],
    esbuild: stripConsoleLogs,
    build: {
        // Vite 7 changed the default to 'baseline-widely-available' (chrome107/safari16).
        // Keep the Vite 6 browser floor until a supported-browser list is agreed.
        target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
        conditions: ['import', 'module', 'browser', 'default'],
    },
    server: {
        port: 5173,
        proxy: {
            // Covers HTTP and the WS endpoint `/<prefix>/websocket`.
            [`/${apiPrefix}`]: {
                target: 'http://127.0.0.1:3000',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    define: {
        BUILD_TIMESTAMP: JSON.stringify(Date.now()),
        __INTLIFY_JIT_COMPILATION__: true,
        __INTLIFY_DROP_MESSAGE_COMPILER__: false,
    },
})
