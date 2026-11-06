# Toolchain

This page collects tool versions, the places where they are pinned, and the compiler, linter and formatter settings. Short update rules are given in the Toolchain Notes section of [`AGENTS.md`](https://github.com/Blazheiko/vibe-template/blob/main/AGENTS.md).

## Versions

| Tool                            | Version                                    | Where it is pinned                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                         | `^24.22.2` (engines), `24.22.2` (`.nvmrc`) | [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json) `engines.node`, [`.nvmrc`](https://github.com/Blazheiko/vibe-template/blob/main/.nvmrc)                                                                                                                                                     |
| pnpm                            | `>=9.0.0` (engines), `pnpm@9.15.0`         | `engines.pnpm` and `packageManager` in [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json)                                                                                                                                                                                                      |
| TypeScript                      | `6.0.3` (exact)                            | root, [`backend`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json), [`frontend`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json), [`documentation`](https://github.com/Blazheiko/vibe-template/blob/main/documentation/package.json) and other packages |
| ESLint                          | `^10.13.0`                                 | [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json)                                                                                                                                                                                                                                             |
| typescript-eslint               | `^8.71.2`                                  | [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json) + `pnpm.overrides`                                                                                                                                                                                                                          |
| Prettier                        | `^3.9.10`                                  | [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json)                                                                                                                                                                                                                                             |
| drizzle-orm / drizzle-kit       | `1.0.0-rc.5` (exact)                       | [`packages/backend/package.json`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json)                                                                                                                                                                                                           |
| Vitest                          | `^5.0.5`                                   | [`backend`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json), [`frontend`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json)                                                                                                                              |
| Playwright (`@playwright/test`) | `^1.64.1`                                  | [`packages/frontend/package.json`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json)                                                                                                                                                                                                         |
| Vue / Vite                      | `^3.5.44` / `^7.3.7`                       | [`frontend`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/package.json), [`api-playground`](https://github.com/Blazheiko/vibe-template/blob/main/packages/api-playground/package.json)                                                                                                                |
| VitePress                       | `1.6.4` (exact)                            | [`documentation/package.json`](https://github.com/Blazheiko/vibe-template/blob/main/documentation/package.json)                                                                                                                                                                                                                 |

::: warning
`engines.node` allows any `24.x` starting from `24.22.2`, while `.nvmrc` specifies exactly `24.22.2`: CI installs this version, so the minimum allowed version and the CI version match. The [`Dockerfile`](https://github.com/Blazheiko/vibe-template/blob/main/Dockerfile) installs the same version (`ARG NODE_VERSION`) in both stages and fails if `node -v` differs. Update `.nvmrc`, `engines` and `NODE_VERSION` together.
:::

## uWebSockets.js patch

`uWebSockets.js` `v20.71.0` has a broken ESM entry point: `ESM_wrapper.mjs` imports `./index.js`, which is not in the package ([uNetworking/uWebSockets.js#1356](https://github.com/uNetworking/uWebSockets.js/issues/1356)). The fix is a one-line patch, [`patches/uWebSockets.js@20.71.0.patch`](https://github.com/Blazheiko/vibe-template/blob/main/patches/uWebSockets.js@20.71.0.patch), wired in through `pnpm.patchedDependencies` in the root `package.json`. With the next uWS release, the patch and the `patchedDependencies` entry are removed.

## `pnpm.overrides`

The root [`package.json`](https://github.com/Blazheiko/vibe-template/blob/main/package.json) forces `@typescript-eslint/utils`, `typescript-estree`, `project-service` and `tsconfig-utils` to `^8.71.2`. This keeps transitive dependencies on a line compatible with TypeScript 6. According to the `AGENTS.md` rule, these overrides are updated together with `typescript-eslint`.

## TypeScript

The shared base lives in [`tsconfig.base.json`](https://github.com/Blazheiko/vibe-template/blob/main/tsconfig.base.json): `target`/`lib` `ES2022`, `module` and `moduleResolution` `NodeNext`. In addition to `strict: true`, these are enabled:

- `noUncheckedIndexedAccess`: index access returns `T | undefined`;
- `exactOptionalPropertyTypes`: an optional field cannot be explicitly assigned `undefined`;
- `noPropertyAccessFromIndexSignature`: an index signature is read only as `obj["key"]` (that is why the config uses `env["CSRF_ENFORCE"]`);
- `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`;
- `isolatedModules` and `verbatimModuleSyntax`: type-only imports must be `import type`.

The backend path aliases in [`packages/backend/tsconfig.json`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/tsconfig.json) (`#app/*`, `#config/*`, `#vendor/*`, `#database/*`, `#drizzle/*`, `#logger`) use relative paths like `./src/app/*`, **without `baseUrl`**. `baseUrl` is deprecated in TypeScript 6 and will stop working in TypeScript 7, so it must not be reintroduced.

## ESLint

The flat config [`eslint.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/eslint.config.ts) is assembled via `tseslint.config(...)`:

- base: `eslint.configs.recommended`, `tseslint.configs.strictTypeChecked`, `stylisticTypeChecked`, type-aware mode via `projectService`;
- globally as `error`: `explicit-function-return-type`, `explicit-module-boundary-types`, `no-explicit-any`, the `no-unsafe-*` family, `strict-boolean-expressions` (without `allowString`/`allowNumber`/`allowNullableObject`), `switch-exhaustiveness-check`, `consistent-type-imports` (inline type imports), `consistent-type-exports`, `no-unused-vars` ignoring `^_`;
- the backend is checked with the full profile. For backend tests (`*.spec.ts`, `*.test.ts`, `src/test-support`) only `explicit-function-return-type`, `no-explicit-any`, `no-empty-function`, `require-await`, `no-non-null-assertion` and `no-dynamic-delete` are disabled — mocks and fixtures; the reason for each is a comment in the config. Isolated exceptions in code are marked with `eslint-disable` and an explanation;
- `packages/frontend` and `packages/api-playground` have their own `eslint.config.ts`. ESLint 10 uses the nearest config for each file, so the root config does not check their files (both `.ts` and `.vue`) — even during the root `eslint .`;
- frontend: `vueTsConfigs.strictTypeChecked` + `stylisticTypeChecked` for `.ts` and `.vue`; `configureVueProject({ rootDir })` binds the `.vue` lookup to the package so that a root run sees the same files. Relaxed with an explanation in the config: `restrict-template-expressions` allows numbers, `prefer-nullish-coalescing` does not touch strings (`||` deliberately treats `''` as a missing value); in tests `no-empty-function` and `no-non-null-assertion` are disabled. The root's project rules (`explicit-function-return-type`, `strict-boolean-expressions`, etc.) do not apply to the frontend;
- api-playground — same as the frontend; `prefer-nullish-coalescing` additionally does not touch numbers and booleans (`status || 200`, `includes() || …` — a deliberate `||`). `testResult` in `TestForm.vue` stays `any` with an explanation: it holds two different result shapes;
- the root `pnpm lint` runs `eslint .` and then `pnpm -r --if-present lint:check` in the packages.

::: info
The root's full profile (with its project rules) applies to `packages/shared`, the backend and root files. The frontend and api-playground have `strictTypeChecked` + `stylisticTypeChecked` without the root's project rules.
:::

## Prettier

- One root [`.prettierrc.json`](https://github.com/Blazheiko/vibe-template/blob/main/.prettierrc.json) for all packages: `tabWidth: 4`, `singleQuote: true`, `semi: false`, `printWidth: 100` — the style from `AGENTS.md`. There are no package-level configs.
- [`.prettierignore`](https://github.com/Blazheiko/vibe-template/blob/main/.prettierignore): `node_modules`, `dist`, `coverage`, Playwright reports, Drizzle migrations, the VitePress cache and dist, `pnpm-lock.yaml`, `graphify-out`.
- The root `pnpm format` / `pnpm format:check` process `**/*.{ts,tsx,js,mjs,vue,json,md,css}` — including the frontend and playground `.vue` files, the `.js`/`.mjs` of the documentation scripts and shared tests, and CSS; CI checks all of this through `format:check`. The package-level `format` in the frontend and playground format only `src/`: to format the whole repository, run the root `pnpm format`.
- Mass formatting (feat-010 and feat-038) is recorded in [`.git-blame-ignore-revs`](https://github.com/Blazheiko/vibe-template/blob/main/.git-blame-ignore-revs). To make `git blame` skip it: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

::: warning Known issue
The `format:check` glob does not cover `.vue`, `.js`, `.mjs` and `.css`, so those files are not checked (item 71 in [`code-issues-found-during-docs.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/code-issues-found-during-docs.md)). The package-level `pnpm --filter frontend format` and `pnpm --filter api-playground format` format `src/` using the root config.
:::

## Drizzle

`drizzle-orm` and `drizzle-kit` are pinned to the release candidate `1.0.0-rc.5` because there is no stable 1.0 yet. They are updated together, to the same exact version, and once `1.0.0` is released they move to it. Relations are described via Relational Queries v2 (`defineRelations` in [`relations.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database/relations.ts)). Migrations are stored in the 1.0 "folder per migration" format. More in the [Database](/en/backend/database) section.

## Tests and documentation

- Vitest is used for backend and frontend unit tests, Playwright for frontend e2e (`pnpm --filter frontend test:e2e`). The `shared` package is tested with Node's built-in runner after the build. See [Testing](/en/backend/testing).
- This site is built with VitePress `1.6.4` and the `vitepress-plugin-mermaid` plugin. The `docs:*` commands are described in the [Scripts](/en/reference/scripts) section.
