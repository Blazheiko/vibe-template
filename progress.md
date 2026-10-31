# Session Progress Log

## Current State

**Last Updated:** 2026-10-31
**Active Feature:** feat-055 - Mermaid 12
**Branch:** `chore/mermaid-12` (status PR #177: feat-054 → `done`, feat-055 → `in_progress`)
**Plan:** `docs/plan/node-24.22.2-uws-20.71-upgrade-plan.md`, PR 5 (D.3)

## Status

### Done

- [x] `mermaid` 11.17.2 → 12.2.0 (documentation). `vitepress-plugin-mermaid` 2.0.17 (latest) declares peer `mermaid: 10 || 11` — pnpm warns; rendering checked below
- [x] Mermaid 12 changes unconfigured diagrams (ELK layout, `redux-color` / `neo` look). `config.ts` keeps the 11 look: `mermaid: { layout: 'dagre', theme: 'default', look: 'classic' }`; the plugin still switches to `dark` in the dark theme
- [x] Clipped node labels: Mermaid 12 sizes a label box with its own 24px line-height, the `<p>` inside got `.vp-doc p` 28px, so the last line of a wrapped label was cut (e.g. «auth_guard», «їх описав»). `custom.css`: `.vp-doc .mermaid foreignObject p { margin: 0; line-height: inherit }`
- [x] Browser check (Playwright, `vitepress preview`): every page with a diagram — 25 pages, 30 diagrams — in light and dark: rendered SVG count = `.mermaid` count, no «Syntax error», no empty SVG, no clipped label (`scrollHeight` ≤ box height), no console errors, `dark` class matches the scheme. Screenshots compared with the 11.17.2 build: sequence/state diagrams identical, flowcharts re-wrap node labels narrower (max 120px), so some are taller

## Evidence of Completion

| Check                                   | Result                            |
| --------------------------------------- | --------------------------------- |
| `pnpm --filter documentation typecheck` | exit 0                            |
| `pnpm docs:build && pnpm docs:verify`   | passed                            |
| `pnpm --filter documentation test`      | 26 passed                         |
| `pnpm format:check` / `lint`            | exit 0                            |
| Browser: 25 pages × 2 themes            | 60/60 diagram renders, 0 problems |

## Notes for Next Session

1. Merge status PR #177 and the feature PR, then the done-PR
2. Last in the plan: PR 3 (`@mistralai/mistralai` 3.x)
