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

## Review of daae9caa (REQUEST CHANGES) and the fixes

1. `--write` could miss a current value written as `export …`, `KEY = …` or with a comment and
   append a new `k1` the server would read last. Now the value is read with `dotenv.parse` (what
   the server reads); a write replaces only a single plain `KEY=…` line (or appends a missing one)
   and refuses any other form; the result is read back before it is written. The shell wins even
   when it sets the variable empty (`--check`), and `--write` refuses while the shell sets it.
2. A first `--write` dropped the `dev` key a non-production start derives from `APP_KEY`. Now it
   writes `k1,dev` when `APP_KEY` is present (`deriveDevMfaKey`, extracted from `config/mfa.ts`,
   so the bytes are the server's); printing never includes `dev`, only a warning.
3. `.env` is replaced atomically (temporary file `.env.<pid>.tmp`, fsync, rename, mode kept,
   symlink target followed) under a lock file `.env.lock` held for the whole read and write; a
   second run is refused.
4. The next id stays within the server's 16 characters (`k999999999999999` → smallest free
   `k<n>`), and every result is checked by `parseMfaEncryptionKeys` before it is printed or written.
5. The deployment checklist and the MFA page say where to run it: a checkout (`pnpm --filter
backend mfa:keys`) or the built image (`node dist/scripts/mfa-keys.js`, printing and `--check`
   only), the value kept in the environment's secrets.

New modules: `mfa-keys-env.ts` (dotenv read, plain-line write, atomic locked update) and
`mfa-keys-run.ts` (the whole run, testable against a temporary directory); `mfa-keys.ts` only
prints its result.

## Evidence of Completion

- `make check` green after the fixes: backend 3738 (36 in `src/scripts/mfa-keys*`), frontend
  1017, shared 149, landing 103, api-playground 115, documentation 26.
- Mutation checks (reverted): reading `.env` with the old line regex fails 3 run tests
  (`export`, spaces, the refused rewrite); ignoring `APP_KEY` on a first write fails both dev-key
  tests. The one lint warning
  (`frontend/e2e/mock/notifications.spec.ts:225`, `no-wait-for-timeout`) is on `main` already.
- `pnpm docs:build && pnpm docs:verify`: passed (links and anchors of the new section included).
- No PG, Redis or UI code changed: `test:pg`, `test:redis`, `test:e2e` are not in scope.
- CI on the branch: see the PR.

## Manual verification

After the fixes, against a scratch `.env` (`APP_KEY` set, mode 640): `--write` gives `k1,dev`,
mode 640 kept; `--rotate --write` gives `k2,k1,dev`; `export MFA_ENCRYPTION_KEYS=…` is seen as
set by `--write` and refused by `--rotate --write`; an existing `.env.lock` refuses the write. The
compiled `node dist/scripts/mfa-keys.js` prints, checks and rotates a shell value.

Before the fixes (daae9caa):

Against a scratch `.env` (`APP_KEY=x`, empty `MFA_ENCRYPTION_KEYS`): print gives `k1:<key>`;
`--check` on empty exits 1 (required in production-like); `--rotate` on empty exits 1; `--write`
saves `k1`; a second `--write` exits 1 (already set, use `--rotate`); `--check` valid, 1 key;
`--rotate --write` gives `k2,k1`; `--check` valid, 2 keys, `k2` encrypts, `k1` reads; a broken
shell value `k1:bad` fails `--check` with the parser's message; `--force` is refused.
