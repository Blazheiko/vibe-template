# feat-177 — Non-JSON Route Contracts (C8)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (C7, C4, C8, C5b, C6), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (C8.S–C8.X). Depends on feat-176.

## State

Done, waiting for review and merge.

## What changed

- **Contract kinds** (`shared/contracts/core.ts`): `kind` is `json` (default, absent at run
  time), `multipart` or `navigation`.
    - `multipartContract<Fields, FileName, Response>()` has a body of `{ fields, files }`.
    - `navigationContract<Query, Response>()(path)` is a GET the browser opens itself (a redirect
      or a file).
    - `shared` declares no DOM, so a file is a structural `FileLike` (`size`, `type`); a browser
      `Blob` or `File` is one.
- **Backend registry:**
    - a multipart entry's body schema is checked against the contract's fields;
    - `defineContractRoute` sets `allowedContentTypes: ['multipart']` from the contract;
    - `maxBodySize` stays a setting of the route.
- **Frontend:**
    - `callApi` sends a multipart contract as `FormData` through `baseApi.upload`, with the same
      CSRF token, session gate and one repeat after a token mismatch;
    - `callApi` refuses a navigation contract at compile time;
    - the new `contractUrl` builds the URL of a navigation contract.
- **Six routes moved:**
    - `POST /avatar/upload` (multipart, file `avatar`) and `DELETE /avatar`;
    - `POST /admin/knowledge-base/:id/screenshot` (multipart, file `screenshot`);
    - `GET /support/screenshot/:articleId` (navigation; `SupportView` uses `contractUrl` for its
      `<img>`);
    - `GET /auth/oauth/:provider/redirect` and `/callback` (navigation; `SocialAuthButtons` uses
      `contractUrl`).
- **Result:**
    - every HTTP route of `http-routes.ts` is declared by contract; `defineRoute` is left only in
      vendor tests, for C5b to remove;
    - `utils/api.ts` no longer imports `baseApi` or `apiPath`;
    - `DIRECT_HTTP_CALLS` and `UPLOAD_CALLS` are 0.
- **Docs:**
    - ADR 0005, decision 3 rewritten;
    - `backend/routing.md` in both locales: all routes on contracts, a section on multipart and
      navigation, the old avatar example labelled as such.

## Evidence of Completion

- New tests:
    - frontend: multipart sends FormData with the CSRF token and no JSON Content-Type; path params
      of a multipart contract; one repeat after a token mismatch with the same files;
      `contractUrl`;
    - frontend, compile-time: `callApi` on a navigation contract, `contractUrl` on a JSON one, a
      missing path parameter, a file under another name, a JSON object as a multipart body;
    - backend: a multipart route accepts only multipart and validates its fields; a navigation
      route is a plain GET; the fields schema of a multipart entry is checked.
- `make check`: backend 2659, frontend 504, shared 30, playground 111; bundle graph: 500 modules,
  no schema.
- `pnpm --filter backend test:pg` (with `REDIS_TEST_URL`): 295 passed.
- `pnpm --filter frontend test:e2e`:
    - the third full run passed 92 of 92;
    - the first two lost 4 and 1 tests: `support input stays visible` in four browsers, then
      `register … client-side validation` with `net::ERR_ABORTED`;
    - both ran while another project's eslint and containers kept the machine at a load average
      of 60–80; the support test passed alone.
- `test:e2e:live`: 13 passed; `test:e2e:security`: 7 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- A real avatar or screenshot upload in a browser against the backend: the multipart path is
  covered by the client tests on the real transport and by the backend upload tests, not
  end to end.
- The OAuth redirect against a real provider.
