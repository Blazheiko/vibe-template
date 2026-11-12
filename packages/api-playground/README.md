# API Playground

Developer-only Vue app that loads the backend route map (`/api/doc/routes`) and lets you call HTTP and WebSocket routes by hand. Not meant for production.

```bash
# packages/backend/.env: APP_ENV=manual-test, DOC_PAGE=true, SERVE_STATIC=true
pnpm dev:manual_test          # from the repo root: shared + backend + playground
# or only the playground (backend already running on :3000):
pnpm --filter api-playground dev
```

Open `http://localhost:5174`. The Vite dev server proxies one key, `/<prefix>` (`VITE_API_PATH_PREFIX`, default `api`), to `127.0.0.1:3000` with `ws: true`, which covers HTTP and the WS endpoint `/<prefix>/websocket`; `VITE_API_BASE_URL` overrides the base URL.

Full description — stack, route loading, UI, settings, WebSocket, troubleshooting, limitations: **[documentation/playground](https://blazheiko.github.io/vibe-template/playground/)**.

Internal notes (ideas, not current behaviour): [`docs/ROADMAP.md`](./docs/ROADMAP.md), [`docs/UI-UX-ANALYSIS.md`](./docs/UI-UX-ANALYSIS.md).
