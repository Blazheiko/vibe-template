import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

import { buildMeta } from './vite.build-meta'
import { productBranding } from './vite.product'
import { stripConsoleLogs } from './vite.console'
import { sharedSource } from './vite.shared-source'
import { pinApiPrefix, readDevBackend } from './vite.backend'

// One source for the backend address and the API prefix: PORT, HOST and API_PATH_PREFIX of
// packages/backend/.env (or the shell). The proxy follows them, and the prefix is compiled into
// the bundle as VITE_API_PATH_PREFIX (feat-192). An object config (vitest.config.ts merges it).
const backend = readDevBackend()
pinApiPrefix(backend.prefix)

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
        productBranding(),
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
            [`/${backend.prefix}`]: {
                target: backend.origin,
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
