# feat-202: Pre-Auth Body Limits

Plan: `docs/plan/security-review-2026-11-12-plan.md`, S08. Finding: M-3 (part 2) of
`docs/security/security-review-2026-11-12.md`. Branch: `fix/pre-auth-body-limits`.

## Current State

Done, in review.

- **Default JSON limit.** A JSON route without a limit of its own takes
  `APP_DEFAULT_JSON_BODY_SIZE` (100 KB), not the whole `APP_MAX_JSON_BODY_SIZE` (2 MiB), which
  stays the ceiling. A route asks for more with `maxBodySize`, up to the ceiling. Only three
  routes do: knowledge base article create and update (30 000 characters) and prompt update
  (50 000). Their limit is `jsonBodyLimit(chars)`: 6 bytes per character plus 16 KiB.
- **Sign-in before the body.** A route with `signedInBeforeBody: true` answers 401 and closes
  the connection when the request has no well-signed cookie of a signed-in session, before a
  byte of the body is read. One HMAC, no I/O (`signed-in-cookie.ts`). Set on the avatar upload
  and the knowledge base screenshot upload, the two multipart routes. An anonymous session
  cookie does not pass. Whether the session still exists is decided by `session_web` later.
- **Rate limit.** The knowledge base screenshot upload is limited to 10 per minute, like the
  avatar routes.

Notes on the design:

- The plan said "raise the JSON limit on the route". Route limits could only tighten the limit
  of their kind, and that rule stays for the ceiling: the default is a second, lower number
  that applies only to routes without their own limit.
- `signed-in-cookie.ts` repeats the signature scheme of `token-handler.ts` instead of importing
  it: `token-handler.ts` validates `APP_KEY` at import, and the check is imported by the server
  itself, which made 66 server tests fail. `signed-in-cookie.spec.ts` holds the two together.

## Files Modified

- `packages/backend/src/vendor/utils/session/signed-in-cookie.ts` (new),
  `vendor/utils/network/errors/sign-in-required-before-body-error.ts` (new)
- `packages/backend/src/vendor/start/server.ts`, `vendor/start/router.ts`,
  `vendor/types/types.d.ts`, `vendor/utils/network/http-request-handlers.ts`, `config/app.ts`
- `packages/backend/src/app/routes/http-routes.ts`, `app/services/shared/upload-limits.ts`,
  `.env.example`
- tests: `pre-auth-body-limits.transport.spec.ts` (new), `signed-in-cookie.spec.ts` (new),
  `app/routes/upload-limits.spec.ts`, `http-request-handlers.spec.ts`,
  `serialize-routes.spec.ts`, `config/app.spec.ts`
- docs uk+en: `backend/configuration.md`, `backend/request-lifecycle.md`

## Evidence of Completion

- `make check`: passing (backend 2912, frontend 558, playground 115).
- `pnpm docs:build && pnpm docs:verify`: passing.
- `pnpm --filter backend test:pg` (32 files, 312 passed) and `test:redis` (11 files, 117
  passed) on real services.
- On a real uWS server (`pre-auth-body-limits.transport.spec.ts`, raw sockets): a JSON body of
  100 KB is taken and one byte more gets 413 with `limit: 102400`; a route with its own limit
  takes 150 KB; an upload with no cookie, a made-up cookie or a stored anonymous cookie gets
  401 from the headers alone, with `Connection: close`, the socket closed and nothing in the
  in-flight budget; with a signed-in cookie the body is read.
- RED: with `server.ts` and `http-request-handlers.ts` as on `main`, 7 cases fail.
- The route table (`upload-limits.spec.ts`): exactly three JSON routes take more than the
  default; every multipart route has `signedInBeforeBody` and `auth_guard`; the schema accepts
  30 000 / 50 000 characters and refuses one more.
- Manual, on the real stack (`playwright.live.config.ts`, a temporary spec, not committed): a
  signed-in avatar upload answered 200 and stored the file; the same upload with no cookie and
  with an anonymous session cookie answered 401; a 150 KB JSON to `/auth/login` answered 413
  with `limit: 102400`; an ordinary sign-in still worked.
- Whole `e2e-live` suite: 14 passed.

## Notes for Next Session

M-3 is closed with feat-201 and feat-202. Next in this chain: feat-206 (HTTP core and cookie
lows). The other open features are lows: feat-203, feat-204, feat-205, feat-207, feat-208.
