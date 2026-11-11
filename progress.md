# feat-162 — Frontend Lows (V16)

Plan: `docs/plan/code-review-2026-11-10-plan.md` (V16), tasks:
`docs/plan/code-review-2026-11-10-tasks.md` (V16.S–V16.X). Low findings of
`docs/plan/code-review-2026-11-10-report.md`. Depends on feat-151.

## State

Done, waiting for review and merge.

## What changed

| Finding                                                             | Before                                                                                                                                            | Now                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized` event (`utils/base-api.ts`)                          | every 401 raised it and App.vue went to `/login`: a wrong password reset the sign-in page, `/verify-email` lost its "session revoked" explanation | a request sent with `csrfRecovery: 'public'` (sign-in, registration, mailed links, password reset) does not raise it; a 401 of any other request still does |
| HTML shell in the cache (`service-worker.ts`)                       | stored under the full URL of the navigation: `/reset-password?token=…` kept the token in Cache Storage for the life of the build                  | stored and looked up by `navigationCacheKey` (origin + path)                                                                                                |
| precache list (`utils/sw-precache.ts`, new)                         | two screenshots that do not exist (404 on every install) and four mp3 files nothing plays                                                         | the list matches `public/`; a unit test checks every path; the mp3 files are out of the list                                                                |
| knowledge base admin (`utils/api.ts`, `AdminKnowledgeBaseView.vue`) | a failed list was an empty list: "No articles yet" and an Init button; a failed delete / reindex / screenshot action said nothing                 | `getAll` throws the server's message, the view shows it and hides Init; every action reports its failure; reindex-all shows the ids it could not embed      |
| Sentry breadcrumbs (`utils/sentry-service.ts`)                      | the message of every breadcrumb went through `maskUrl`: `WebSocket connected` became `https://host/WebSocket%20connected`                         | only the URLs inside a message are masked                                                                                                                   |

Also: `tsconfig.vitest.json` includes `src/env.d.ts` (a spec now imports `service-worker.ts`,
which uses the `BUILD_TIMESTAMP` global declared there).

Docs (both locales): `backend/caching-etag.md` (the service worker section).

**Decision for V17 (V16.3):** nothing in `src/` plays the files of `public/audio`; they are out
of the precache now, and V17 deletes the four files and the `/audio/` prefix of
`STATIC_PREFIXES` together with the notification sound button.

## Evidence of Completion

### RED (new tests against the old code, 15 failed)

```
api-unauthorized-event.spec.ts
 × is not raised by a wrong password on sign-in
 × is not raised by a revoked session on /verify-email: the view explains it
service-worker-fetch.spec.ts
 × stores a navigation without its query string
 × answers an offline navigation with the copy stored for the path
 × names only files that exist in public/
admin-query.spec.ts
 × knowledge base: a failed list throws the message of the response
 × knowledge base: reindex-all returns the failed ids, and null when it fails
AdminKnowledgeBaseView.spec.ts   × 7 (failed list, Delete, Reindex, Del Screenshot, reindex-all, screenshot upload)
sentry-service.spec.ts
 × masks the URLs of a breadcrumb message and leaves plain text alone
e2e/mock/unauthorized.spec.ts
 × a revoked session on /verify-email is explained on that page   (the app went to /login)
```

### After the fix

- `make check`: frontend 43 files / 484 tests, backend 2655, shared 30, playground 81.
- `pnpm --filter frontend test:e2e`: 89 passed.
- `pnpm docs:build && pnpm docs:verify`: passed.

### Not verified

- The service worker was exercised through its `fetch` listener in jsdom with faked `caches`,
  not in a browser: Cache Storage of a real install was not inspected.
- A signed-in user whose session is revoked while a public form is open keeps the signed-in UI
  until the next protected request answers 401.
- The knowledge base admin view was not opened against a running backend.
