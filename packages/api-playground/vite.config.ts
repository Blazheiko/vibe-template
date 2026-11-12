import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseEnv } from 'node:util'

import { defaultClientConditions, defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { assertSameApiPrefix, resolveDevBackend } from 'shared/dev-backend'

const BACKEND_ENV_FILE = fileURLToPath(new URL('../backend/.env', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
    // One source for the backend address and the API prefix, as in frontend/vite.backend.ts:
    // PORT, HOST and API_PATH_PREFIX from the shell, else packages/backend/.env (feat-192). The
    // proxy follows them and the prefix reaches the bundle as VITE_API_PATH_PREFIX; a different
    // value set by hand fails here.
    const backend = resolveDevBackend(
        process.env,
        existsSync(BACKEND_ENV_FILE) ? parseEnv(readFileSync(BACKEND_ENV_FILE, 'utf8')) : {},
    )
    // loadEnv() types every key as present; the variable may be unset.
    const own = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_PATH_PREFIX as string | undefined
    assertSameApiPrefix(own, backend.prefix)
    process.env.VITE_API_PATH_PREFIX = backend.prefix
    return {
        // Same as the frontend (see frontend/vite.console.ts): the minifier drops these calls from
        // the production bundle; dev keeps its logs. warn and error stay.
        esbuild: { pure: ['console.log', 'console.info', 'console.debug', 'console.trace'] },
        plugins: [vue(), vueDevTools()],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
            },
            // The dev server reads `shared` from its src/ (the `shared-source` export condition in
            // packages/shared/package.json), so a change there needs no rebuild. `vite build` and
            // Vitest (mode `test`) stay on dist/. Same as frontend/vite.shared-source.ts.
            ...(command === 'serve' && mode !== 'test'
                ? { conditions: ['shared-source', ...defaultClientConditions] }
                : {}),
        },
        server: {
            port: 5174,
            proxy: {
                // Covers HTTP and the WS endpoint `/<prefix>/websocket`.
                [`/${backend.prefix}`]: {
                    target: backend.origin,
                    changeOrigin: true,
                    ws: true,
                },
            },
        },
    }
})
