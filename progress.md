# feat-220 One Address Rule For Both Landing Validators — progress

Branch: `fix/landing-address-rule`. Source: the review of #660 (feat-219), one P2 finding. Fixed.

## Finding

`scripts/verify-landing-deploy.sh` cut the host at the first `:` and did not normalize it, while `build/urls.ts` used a WHATWG URL parser. Reproduced, and the gap was wider than the review showed:

| URL                            | WHATWG host | Old shell check | Old TypeScript check |
| ------------------------------ | ----------- | --------------- | -------------------- |
| `https://[::1]/login`          | `[::1]`     | accepted        | refused              |
| `https://2130706433/login`     | `127.0.0.1` | accepted        | refused              |
| `https://0x7f000001/`          | `127.0.0.1` | accepted        | refused              |
| `https://local%68ost/`         | `localhost` | accepted        | refused              |
| `https://ｌｏｃａｌｈｏｓｔ/`  | `localhost` | accepted        | refused              |
| `https://evil.com\@localhost/` | `evil.com`  | refused         | accepted             |

## Fix

Re-implementing WHATWG host normalization in bash 3.2 would not be reliable. Instead both validators adopt one stricter rule, step by step and message by message:

1. no backslash, whitespace or control characters;
2. `https`;
3. the host as written: after `scheme://` and userinfo, before the port; lowercased; trailing dots dropped; it must not be empty;
4. a valid port;
5. no IP literal: an IPv6 address in brackets, or a host whose last label is a number or `0x…`, which a URL parser reads as IPv4;
6. only `[a-z0-9.-]`;
7. not local, not RFC 2606.

`verify-landing-deploy.sh` gains `--check-address URL`. The new `build/__tests__/address-rule.spec.ts` runs 37 cases through `productionProblem` and the shell script and expects the same answer, word for word.

## Evidence of Completion

- `make check` green: landing 103 tests (previously 66), backend 2983, frontend 607, api-playground 115.
- Mutation check: with the old host cut and without the numeric-host rule in the shell, 9 of the 37 cases fail. With the fix restored, all 37 pass.
- Strict landing build: passes with `https://app.vibe.dev` and `https://vibe.dev`; refuses `https://2130706433` as an IP address.
- `pnpm docs:build && pnpm docs:verify` green. The rule and its reason are documented in `documentation/landing/index.md` and `en/`.
