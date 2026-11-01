# Session Handoff

feat-069 (auth regression coverage) is split in three PRs on `test/auth-regression-coverage`-style branches: G1 (backend contract tables and the three mail snapshots, merged or in review), G2 (Playwright on mocks), G3 (Playwright on the live backend). feat-069 stays `in_progress` until all three are in; then flip it to `done` on `main`. The next features (H1–H5, `feat-070…074`) depend on it and must not change a row of these tables.
