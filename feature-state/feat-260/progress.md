# feat-260: MFA Encryption Keys Script

## Status

Implemented, ready for review. Branch `feat/mfa-keys-script`. Registered in #828.

## Baseline

`./init.sh` on `main` (7400c6a) reached `format:check` and failed only on this feature's new,
not yet formatted files; formatted, then `make check` green.

## Scope

`pnpm --filter backend mfa:keys` (`make mfa-keys ARGS=…`, root `pnpm mfa:keys`) for
`MFA_ENCRYPTION_KEYS`, which a production-like start requires:

- no argument: prints a new value, one key `k1` of 32 random bytes;
- `--write`: saves it to `packages/backend/.env`, refuses when a key is already set;
- `--rotate`: a new key with the next free id first, every current key kept in order; refuses an
  empty or invalid current value; with `--write` rotates the value in `.env`;
- `--check`: validates with `parseMfaEncryptionKeys` as a production-like start, prints only ids.

The current value is `MFA_ENCRYPTION_KEYS` of the shell when set, else `.env`; with `--write`,
always `.env`.

Files: `packages/backend/src/scripts/mfa-keys.ts` (CLI), `mfa-keys-args.ts`, `mfa-keys-list.ts`
and their specs; `package.json` (backend, root), `Makefile`, `.env.example`, scripts README;
docs `documentation/backend/mfa.md` (new section «Ключі шифрування»), `configuration.md`,
`deployment.md`, both locales.

## Evidence of Completion

- `make check` green: backend 3710 (8 new), frontend 1017, shared 149, landing 103,
  api-playground 115, documentation 26. The one lint warning
  (`frontend/e2e/mock/notifications.spec.ts:225`, `no-wait-for-timeout`) is on `main` already.
- `pnpm docs:build && pnpm docs:verify`: passed (links and anchors of the new section included).
- No PG, Redis or UI code changed: `test:pg`, `test:redis`, `test:e2e` are not in scope.
- CI on the branch: see the PR.

## Manual verification

Against a scratch `.env` (`APP_KEY=x`, empty `MFA_ENCRYPTION_KEYS`): print gives `k1:<key>`;
`--check` on empty exits 1 (required in production-like); `--rotate` on empty exits 1; `--write`
saves `k1`; a second `--write` exits 1 (already set, use `--rotate`); `--check` valid, 1 key;
`--rotate --write` gives `k2,k1`; `--check` valid, 2 keys, `k2` encrypts, `k1` reads; a broken
shell value `k1:bad` fails `--check` with the parser's message; `--force` is refused.
