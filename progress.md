# feat-219 Landing Review Fixes — progress

Branch: `fix/landing-review`. Source: the review of #657 (feat-217), four findings. All are fixed.

## Fixed

1. **P2: the deploy check skipped addresses outside the two origins.**
    - `scripts/verify-landing-deploy.sh` filtered the published addresses by the SITE/APP prefix before validating them, so an `og:image` on `http://localhost:9999` passed.
    - Now `published_addresses` reads canonical, hreflang, `og:url`, `og:image` and both buttons from their tags, with no origin filter.
    - `og:image` is also checked to equal `<site>/og-image.png`.
2. **P2: prod-local did not watch the landing preview.**
    - The preview now binds `127.0.0.1` explicitly. On `localhost`, Vite took `[::1]:4174` while another process held `127.0.0.1:4174`, and `--strictPort` did not notice. This was reproduced while fixing.
    - The backend starts only after the preview serves this landing: a page with `href="<ORIGIN>/register"`.
    - A landing built for another app address (with `PROD_LOCAL_SKIP_BUILD`) stops the run with an explanation.
    - Whichever process exits first stops the other. It is a loop, since macOS ships bash 3.2 without `wait -n`.
3. **P2: a trailing DNS dot bypassed the strict domain checks.**
    - `build/urls.ts` and the shell script drop trailing dots before comparing hosts.
    - The placeholder list now has the rest of RFC 2606: `.test`, `.invalid`.
4. **Lower: the dev middleware answered an unknown `.html` path with an empty 404.**
    - `isViteRequest` leaves `.html` and `.htm` to the landing, which renders the 404 page, as nginx does.

## Evidence of Completion

- `make check` green: backend 2983, frontend 607, api-playground 115, landing 66 (previously 46).
- Regression tests:
    - `build/__tests__/urls.spec.ts`: trailing dot, `.test` and `.invalid`.
    - `build/__tests__/landing-plugin.spec.ts`: `isViteRequest`.
    - `build/__tests__/verify-landing-deploy.spec.ts`: runs the shell script in strict mode against two https stand-ins (self-signed certificate, `landing.vibe.dev` and `app.vibe.dev` through the new `--resolve`). Four cases: a correct deployment, a foreign `og:image`, a trailing-dot placeholder, a SPA fallback.
    - A mutation check reintroduced the origin filter and dropped the dot normalization: the `og:image` and trailing-dot tests failed. With the fix restored, all four pass.
- Dev server: `/missing.html` → 404 with `data-page="not-found"`; `/uk/index.html` → 200; `/nope.png` → empty 404 from Vite.
- `prod-local` scenarios (`PROD_LOCAL_SKIP_BUILD=true PROD_LOCAL_LANDING=true`):

    | Scenario                              | Result                                   |
    | ------------------------------------- | ---------------------------------------- |
    | Port 4174 held by another server      | exit 1, "is port 4174 busy?", no backend |
    | Landing built for another app address | exit 1 with an explanation               |
    | Preview killed                        | backend stopped, exit 1                  |
    | Backend killed                        | preview stopped                          |
    | SIGTERM to the script                 | exit 130                                 |

    In every case no process was left on 3000 or 4174.

- `pnpm --filter landing test:e2e` 36/36; `pnpm docs:build && pnpm docs:verify` green.
- Docs (`documentation/landing/index.md` + `en/`): the RFC 2606 list and the trailing dot, prod-local start-up and shutdown, every published address checked, `--resolve`.
