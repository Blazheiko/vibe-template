# Session Progress Log

## Current State

**Last Updated:** 2026-11-02
**Active Feature:** feat-082 - Env Parsing Contract (review)
**Branch:** `chore/env-parsing-contract`
**Plan:** `docs/plan/code-review-fixes-tasks.md`, phase N

## Status

A behaviour change, on purpose (that is why it is not part of phase H): booleans and integers of the `.env` are read by one contract.

- [x] **The contract** (`documentation/backend/configuration.md`, "Булеві та цілі значення"): boolean = `true|1|yes|on` / `false|0|no|off`, any case, outer whitespace ignored; integer = decimal digits only, within the variable's `{min, max}`, a safe integer; blank or unset = the default; anything else = a startup error that names the variable
- [x] **One implementation** in `vendor/utils/env/`: `parse-boolean.ts` (`parseBoolean(name, raw, default)`), `read-int.ts` (`parseInteger`), `env-reader.ts` (`createEnvReader()`: `.int()`, `.bool()`, `.error` collecting every problem of a module, once each)
- [x] **Replaced**: `readInt` (throttle-policies), `readInteger` (rate-limit), `readTimeoutMs` / `readPromptCacheTtlMs` / `readTokenCount` / `readPositiveInt` / `readStrictBoolean` (ai), `parseNumberFlag` / `parseBooleanFlag` (auth, network), `parsePort` (app, mail), the local `parseBoolean` of cors and mail, the integer reads of redis, health, support, session, websocket, and the callers of the old `parseBoolean` (app, csp, csrf, sentry, session). `database.ts` keeps its own `parsePort` with the same digits-only rule, because drizzle-kit loads it without path aliases
- [x] **Reported through `validateRuntimeConfig`**: `app`, `auth`, `mail`, `cors`, `network`, `sentry` and `session` got a `configError` and are checked there (`Invalid <area> configuration: ...`); the others already had one
- [x] **Spec**: `env-contract.spec.ts` (the table of values: 51 cases of the two parsers and the reader) and "env parsing contract" in `validate-runtime-config.spec.ts` (20 boolean and 18 integer variables each stop the start naming themselves; `AUTH_PHONE_ENABLED=yes` is true; `PORT=abc` is refused; a blank is the default). The older specs changed where the contract changed: blank rate-limit value is no longer an error; `AI_USAGE_STORE_PROMPTS` takes `yes/1/on` (`ture` is still refused); messages `must be an integer >= 0` / `must be one of true, 1, yes, on, ...`

### What changes for an operator

- `AUTH_PHONE_ENABLED=yes`, `TRUST_PROXY=on`, ... now work everywhere; `True`/`TRUE` too (`APP_IS_PRODUCTION=True` used to be false)
- A typo in a flag (`CSRF_ENFORCE=flase`) used to be false silently, now stops the start
- `PORT=abc`, `SMTP_PORT=0` used to fall back to `3000` / `587`, now stop the start
- `AUTH_*=1e3`, `0x10`, `-1`, `1.5` used to be accepted by `Number()`, now stop the start
- Blank numbers in rate-limit variables used to stop the start, now they are the default

### Not changed (outside the contract)

Sizes in bytes (`APP_MAX_BODY_SIZE`, ...), the duration `SESSION_ANON_TTL`, the fractions `SENTRY_TRACES_SAMPLE_RATE` and `SUPPORT_SEARCH_MAX_DISTANCE`, `OPENAI_EMBEDDING_DIMENSIONS` (must equal the column size), `scripts/purge-llm-prompts-args.ts` (a CLI argument, not an env variable)

## Evidence of Completion

| Check                                      | Result                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `pnpm typecheck` / `lint` / `format:check` | exit 0                                                                   |
| `pnpm build`                               | exit 0                                                                   |
| `pnpm test`                                | backend 1844 (+113), frontend 344, shared 24, api-playground 62, docs 26 |
| `docs:build && docs:verify`                | passed                                                                   |
