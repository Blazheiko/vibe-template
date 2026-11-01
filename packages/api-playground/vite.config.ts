import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    // Proxy the backend's API_PATH_PREFIX, not a hard-coded /api (code-issues item 62).
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    // loadEnv() types every key as present; the variable may be unset.
    const prefix =
        ((env.VITE_API_PATH_PREFIX as string | undefined) ?? '').trim().replace(/^\/+|\/+$/g, '') ||
        'api'
    return {
        // Same as the frontend (see frontend/vite.console.ts): the minifier drops these calls from
        // the production bundle; dev keeps its logs. warn and error stay.
        esbuild: { pure: ['console.log', 'console.info', 'console.debug', 'console.trace'] },
        plugins: [vue(), vueDevTools()],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
            },
        },
        server: {
            port: 5174,
            proxy: {
                // Covers HTTP and the WS endpoint `/<prefix>/websocket`.
                [`/${prefix}`]: {
                    target: 'http://127.0.0.1:3000',
                    changeOrigin: true,
                    ws: true,
                },
            },
        },
    }
})
