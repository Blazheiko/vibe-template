# Progress: feat-186 Contract Drift Guards

## Current state

Done, in review. The review of `main` 4b65696 found five gaps in drift protection. All five are closed, one commit each.

1. **Session refresh from the contract** (`861e558`). `base-api.ts` takes the path and method of `main/init` from `mainContracts.init`, both for the direct `fetch` of the refresh and for the check of the init token.
2. **Required query** (`7ffab01`). `callApi` and `contractUrl` require `query` when one of its keys is required.
3. **Backend path params** (`06f568a`).
    - `HttpContext` and `HttpData` take `TParams` (default `Params`). `defineRoute` passes `PathParams` of the contract, and the handler type is wrapped in `NoInfer`.
    - Controllers that read params declare `ParamsOf<typeof contracts.x>`: push subscriptions, knowledge base, prompts, OAuth, support screenshot, admin online user.
4. **Unique contracts** (`add2d18`).
    - `contractSchemas` refuses a duplicate within a group, and `mergeContractSchemas` refuses one across groups, both at import.
    - `route-contracts.spec.ts` checks all contracts of `shared/contracts` (66) against the registry, and that no two routes share a key.
5. **ESLint** (`eff73ef`). Forbidden:
    - the default import of `base-api` (any name, `import *`, `import()`) outside `api-client.ts`;
    - `fetch`, `window.fetch`, `globalThis.fetch` and `self.fetch` outside `base-api.ts` and the service worker.

    `src/__tests__/api-bypass-lint.spec.ts` runs the real config on samples.

- Docs, both locales: `backend/routing.md`, `backend/controllers.md`, `guide/http-request.md`. Also an addendum to ADR 0005.

## Evidence of Completion

- `make check`: passing (backend 2690, frontend 526, api-playground 115, shared 31, documentation 26; verify-compose and check-bundle-graph pass).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter frontend test:e2e`: 92 passed. `test:e2e:live`: 13 passed.
- `test:pg`: 297 passed. `test:redis`: 116 passed. Both used a separate `redis:7-alpine` on 56379, because the shared Redis on 6379 had stopped; the container is stopped after the run.
- RED before the changes:
    - the new type tests in `api-client.spec.ts` and `define-route.spec.ts` (for params: without `ParamsOf` in `defineRoute`, the rename check is an unused `@ts-expect-error`);
    - `base-api-init-contract.spec.ts`, the duplicate tests, and `api-bypass-lint.spec.ts`.

## Notes for Next Session

Nothing open.
