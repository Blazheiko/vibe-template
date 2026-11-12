# feat-191: Product Name From One Place

Branch: `feat/product-name`. Status: ready for review.

## Problem

Code-review finding: the product name was written separately in index.html, the PWA manifest,
MenuButton, Login, ManifestoSocial, the locales, robots.txt, the email layout and texts, the AI
support prompts and send-test-email. `documentation/guide/your-project.md` listed a dozen files to
rename by hand, and `APP_NAME` (the process title) looked like the product name but is not.

## Change

- `packages/shared/src/product/index.ts` (new subpath `shared/product`): `PRODUCT` with `name`,
  `shortName`, `logoText`, `tagline`, `description`, `siteUrl`, `supportEmail`.
- `packages/frontend/vite.product.ts`: fills `%PRODUCT_*%` in index.html (HTML-escaped; JSON-LD as
  JSON with `<` escaped; an unknown placeholder fails the build), generates `manifest.json` and
  `robots.txt` (dev middleware + `generateBundle`); `public/manifest.json` and `public/robots.txt`
  removed.
- Frontend: Login (hero title, typed logo, mobile title via `{name}`), MenuButton (`pwa-install`
  name/description), ManifestoSocial read `PRODUCT`; `login.heroTitle` removed from the locales;
  the service-worker error-queue cache is `__app_sw_error_queue__` (no brand in an identifier).
- Backend: email layout header, reset/verification/link/OAuth-link texts, AI support prompts
  (name + support email), `mail:test` subject read `PRODUCT`.
- Docs (uk+en): `guide/your-project.md` §1 now points at one file and lists what stays manual
  (images, PWA colors, workspace name, DB name); `APP_NAME` described as the process name in the
  guide and `backend/configuration.md`.

## Evidence of Completion

- `make check` (format, typecheck, lint, test): passing — backend 2693, frontend 539,
  api-playground 115, shared 33, documentation 26.
- `pnpm --filter frontend test:e2e`: 92 passed.
- `pnpm docs:build && pnpm docs:verify`: passing.
- The nine email file snapshots are unchanged (byte-identical, no diff in `__snapshots__/`).
- New tests: `auth-email-templates.snapshot.spec.ts` renders the three auth mails with another
  product name (escaped in HTML, no "vibe" anywhere); mutation: with the old hard-coded email
  header 3 of them fail. `vite-product.spec.ts` (7): placeholders, escaping, JSON-LD, unknown
  placeholder, manifest, robots. The SW precache test accepts generated files.
- Manual: `vite build` writes `dist/manifest.json` and `dist/robots.txt` and an index.html with no
  `%PRODUCT_` left and valid JSON-LD; the dev server answers `/manifest.json`
  (`application/manifest+json`), `/robots.txt` and `/` with the filled title.

## Notes for Next Session

Nothing open. After merge: the "Mark feat-191 done" PR deletes this file.
