import { defaultClientConditions, type Plugin } from 'vite'

// The dev server resolves `shared` from its src/ through the `shared-source` export condition
// (packages/shared/package.json), so a schema or contract change reaches HMR without rebuilding the
// package. `vite build` and Vitest (mode `test`) keep reading dist/, like the backend in production.
// The hook prepends the condition to the list the config already has instead of returning a
// partial config: Vite concatenates arrays on merge, and an unset list means Vite's defaults.
export function sharedSource(): Plugin {
    return {
        name: 'shared-source',
        config(config, { command, mode }) {
            if (command !== 'serve' || mode === 'test') return
            config.resolve ??= {}
            config.resolve.conditions = [
                'shared-source',
                ...(config.resolve.conditions ?? defaultClientConditions),
            ]
        },
    }
}
