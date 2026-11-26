// The e-mail address accounts are stored and looked up by (feat-266, ADR 0007, plan Р6). Only
// normalizeEmail makes a NormalizedEmail, so a lookup or a write cannot forget the normalization:
// `findByEmail(payload.email)` does not compile. The SQL still compares with LOWER() as a guard for
// rows written before.
//
// No # imports in app/domain (plan Р3, Р10).

import type { Brand } from 'shared/brand'

export type NormalizedEmail = Brand<string, 'NormalizedEmail'>

/** The one form of an e-mail address: trimmed, lower case. */
export const normalizeEmail = (email: string): NormalizedEmail =>
    email.trim().toLowerCase() as NormalizedEmail
