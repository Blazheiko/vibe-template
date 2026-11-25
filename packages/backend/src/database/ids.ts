import type { Brand } from 'shared/brand'

// Branded ids of the rows (feat-263, ADR 0007): one brand per table, so ids of two different
// tables do not mix up at compile time. Declarations only: database/schema.ts puts them on the
// columns with `.$type<…>()` (a relative type import, since drizzle-kit loads the schema without
// the # aliases), and app/domain/ids.ts has their constructors. A brand is added in the same
// feature as the signatures of its domain: a branded column refuses a plain bigint in eq().

export type UserId = Brand<bigint, 'UserId'>
export type OAuthAccountId = Brand<bigint, 'OAuthAccountId'>
