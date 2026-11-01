# Session Handoff

feat-066 (auth response contract) is implemented on `fix/auth-response-contract`: unverified login answers the generic 401 (verification mail resent in the background, once per 5 minutes), registration hashes the password before the email lookup. After the PR merges, flip feat-066 to `done` on `main`. Next: F3 (feat-067), F4 (feat-068), F1 (feat-065).
