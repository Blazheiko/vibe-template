# Landing page

`packages/landing` is the template's static public page: what the project is, what it already does, the stack and how to start. The Log in and Sign up buttons lead to the app's `/login` and `/register`, where the frontend opens its sign-in and sign-up dialogs ([router/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/router/index.ts)). The landing calls no API, sets no cookie and carries no JavaScript.

## How it works

- **Vue 3 + Vite with no client entry.** One module renders the pages: [`src/entry-server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/src/entry-server.ts), through `renderToString` from `vue/server-renderer`.
    - `vite build` prerenders every page into static HTML.
    - The dev server renders the same page on each request.
    - Dev and build produce the same markup.
- **Three languages.** `en` at `/`, `uk` at `/uk/`, `pl` at `/pl/`. Each is its own HTML file with `lang`, `canonical`, `hreflang` (plus `x-default` → `/`) and Open Graph. The language switcher is plain links.
- **Texts** live in [`src/content/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/landing/src/content): one file per language, with a shared `LandingContent` type. A key missing from a language fails `typecheck`. The product name comes from `PRODUCT` ([`shared/product`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/product/index.ts)).
- **Styles** are plain CSS files in [`src/styles/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/landing/src/styles), linked from `index.html`. Light and dark themes follow `prefers-color-scheme`. An ESLint rule forbids `<style>` blocks in components: with no client entry, Vite never puts them into the page.
- **Not a SPA.** An unknown path is a 404 with `404.html`, not the home page with 200. That is why Vite runs with `appType: 'mpa'`.

## Addresses

The landing and the app live on different origins, for example `https://example.com` and `https://app.example.com`. One origin is not supported: the backend answers every unknown path with the SPA, and the app's service worker controls `/`.

| Address                   | Variable           | When not set                                                            |
| ------------------------- | ------------------ | ----------------------------------------------------------------------- |
| Where the buttons lead    | `LANDING_APP_URL`  | `FRONTEND_URL` of `packages/backend/.env`, else `http://localhost:5173` |
| The landing's own address | `LANDING_SITE_URL` | `LANDING_URL` of `packages/backend/.env`, else `http://localhost:5175`  |
| The app's public address  | `PRODUCT.siteUrl`  | set in code; the landing does **not** change or read it                 |

Both landing variables are origins: no path, no trailing `/`. [`build/urls.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/urls.ts) reads them at build time, and they are compiled into the HTML. The landing has no `.env` of its own.

**Strict mode** is on only with an explicit `LANDING_STRICT=true`; it does not follow the Vite mode. In strict mode the build refuses any address that:

- does not use `https`;
- points to `localhost`, `127.0.0.1` or `*.localhost`;
- is an RFC 2606 placeholder domain (`example.com`, `.example` and so on).

`LANDING_STRICT=false` or no variable gives an ordinary local build. Any other value is an error.

::: tip "same origin" error with an old `.env`
Before the landing, `.env.example` set `LANDING_URL=http://localhost:5173`, which is the SPA's address. A landing build with that `.env` stops with a same-origin message. Change the line to `LANDING_URL=http://localhost:5175`.
:::

## Running locally

| Mode                  | Command                                                      | Addresses                                                                  |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Development           | `make dev` (with backend and frontend) or `make dev-landing` | landing `http://localhost:5175`, SPA `:5173`, API `:3000`                  |
| Production-like       | `make prod-local`                                            | landing `http://localhost:4174` (`vite preview`), app `:3000`              |
| Build and preview     | `make build-landing`, then `make preview-landing`            | `http://localhost:4174`                                                    |
| All in Docker Compose | `make app-build`, then `make app-up`                         | landing `http://localhost:8080` (`LANDING_PORT`), app `:3000` (`APP_PORT`) |

In development, CSS changes apply without a page reload. A text or component change reloads the page, which renders again: the plugin [`build/landing-plugin.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/landing-plugin.ts) watches the SSR modules.

`make prod-local` builds the landing with buttons pointing at `http://localhost:<PORT>` and stops it together with the backend. The frontend e2e runs call the script without the landing: only `PROD_LOCAL_LANDING=true`, set by `pnpm prod:local`, turns it on.

In compose the landing is the `landing` service of the `app` profile. Its image is built by [`scripts/docker-build.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/docker-build.sh) with buttons pointing at `http://localhost:APP_PORT`. So change `APP_PORT` and `LANDING_PORT` before `make app-build`, not after.

## Build and checks

`pnpm --filter landing build` runs these steps in order:

1. `vue-tsc`.
2. The SSR build of `entry-server.ts`.
3. The client build: only `index.html` and the CSS.
4. The prerender into `dist/`: `index.html`, `uk/index.html`, `pl/index.html`, `404.html`, `sitemap.xml`, `robots.txt`.

The build ends with the `dist/` checks ([`build/verify-dist.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/verify-dist.ts)); any problem fails it. The checks confirm that:

- every page is there, each with the right `lang`, `canonical`, `hreflang` and `og:url`;
- both buttons lead to `LANDING_APP_URL`;
- the HTML has no `<script>`, and the CSS comes from `/assets/`;
- the sitemap and robots point to `LANDING_SITE_URL`.

In strict mode the address rules also cover `<loc>` in the sitemap, `Sitemap:` in robots, `canonical`, `hreflang`, `og:url` and the buttons. The `xmlns="http://www.sitemaps.org/..."` namespace is not an address.

Tests:

- `pnpm --filter landing test`: Vitest for the addresses, the rendering and the `dist/` checks.
- `make test-e2e-landing`: builds the landing and runs Playwright on `vite preview` in three projects: Chromium, Chromium with JavaScript disabled, and mobile. The buttons are checked by their address; the app is not started.

## Docker image

[`packages/landing/Dockerfile`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/Dockerfile) builds from the repository root in two stages: Node builds `shared` and the landing, then nginx (`nginx-unprivileged`, non-root, port `8080`) serves `dist/`.

```bash
docker build -f packages/landing/Dockerfile \
  --build-arg LANDING_APP_URL=https://app.example.com \
  --build-arg LANDING_SITE_URL=https://example.com \
  -t <registry>/landing:<tag> .
```

- `LANDING_APP_URL` and `LANDING_SITE_URL` are required: without them the build stops with a hint.
- `LANDING_STRICT` defaults to `true`. The local `docker-build.sh` passes `false`.
- nginx only serves files. TLS, domains and redirects belong to the proxy in front of it.
- The config, [`nginx/default.conf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/nginx/default.conf), provides:
    - a real 404 with `404.html`;
    - `immutable` caching for `/assets/`, `no-cache` for everything else;
    - a relative `/uk` → `/uk/` redirect;
    - `/healthz` for the healthcheck.
- The security headers (a CSP with no scripts, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) come from [`nginx/security-headers.conf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/nginx/security-headers.conf). HSTS belongs to the TLS proxy.

[`scripts/verify-landing-deploy.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-landing-deploy.sh) checks a deployed landing:

```bash
scripts/verify-landing-deploy.sh https://example.com https://app.example.com
scripts/verify-landing-deploy.sh --allow-local http://localhost:8080 http://localhost:3000   # the local compose stack
```

The script checks:

- `/`, `/uk/` and `/pl/` answer 200;
- an unknown path returns 404 with the 404 page itself;
- the security headers;
- `canonical` and `hreflang` on the landing's origin, the buttons on the app's origin;
- the sitemap and robots;
- `<app>/login` answers 200.

Without `--allow-local`, every published address must be a public `https` one.

::: warning Planned
Deploying the whole application with the landing to Hetzner through Dokploy (`docker-compose-prod.yml`, Traefik, domains, variables) is feature `feat-218`. Until it lands, deploy the landing image behind any reverse proxy with TLS.
:::

### Other hosting

`packages/landing/dist/` is plain static files, so any host can serve it. What to carry over from `nginx/`:

- the security headers;
- `404.html` with a 404 status, no SPA rewrite;
- long caching for `/assets/`.

The site must be at the domain root: language paths and `hreflang` are absolute from `/`. Build with `LANDING_STRICT=true` and check the result with `verify-landing-deploy.sh`. The documentation does not test this path.

## Making changes

- **Texts:** `src/content/<language>.ts`. Add a new key to `types.ts` first, and typecheck lists the languages that miss it.
- **Sections:** components in `src/components/`; `src/App.vue` sets their order.
- **Styles:** `src/styles/tokens.css` (colours, light and dark), `layout.css`, `sections.css`.
- **A new language:** add it to `LOCALES` (`content/types.ts`) and its path to `LOCALE_PATHS` (`src/routes.ts`), create its dictionary and add it to `CONTENT` (`src/pages.ts`). Also add the path to the checks in `scripts/verify-landing-deploy.sh` and to the e2e tests.
