# feat-288 · e2e-live: passkey button step without a presence race

Branch `fix/e2e-live-passkey-button`, owner Blazheiko. Test only.

## Problem

`e2e-live/passkeys.spec.ts:49`, the button step, failed on #913 (feature_list.json only) and #914 (feat-279) after feat-278 made the app start faster; it passed on the reruns and on the main pushes. The CI trace of #913: after `goto('/login')` one `POST /api/auth/passkey/options`, no `passkey/verify`, the page stays on `/login` for 10 s.

The step turned the virtual authenticator's user presence off, clicked the button, then turned presence on. `WebAuthn.setAutomaticPresenceSimulation` decides the presence test of the requests that start after it: a `get()` that had started under presence off never resolves. The step passed only when the CDP call won the race against the start of `get()`.

## Change

The step now does what its comment meant: presence off, the autofill ceremony starts (a pointer in the identifier field) and waits; after its options and a short wait presence is on again; the button starts its own ceremony, which replaces the waiting one and resolves.

## Evidence of Completion

- `make check`: see the PR (test file only; lint, format and typecheck of `e2e-live` cover it).
- The local e2e-live database of this machine is from an older schema (`db:migrate` fails on it); not dropped. The proof is CI: `e2e-live` green on this PR, run several times.
