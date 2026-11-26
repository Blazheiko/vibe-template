import { randomUUID } from 'node:crypto'
import { normalizeEmail } from '#app/domain/email.js'

import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import type { DbTransaction } from '#app/repositories/index.js'
import { systemActor } from '#app/services/audit/audit-actor.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import { mfaSecretBox, totpSecretOwner } from '#app/services/auth/mfa/mfa-secret-box.js'
import { llmSystemPrompts, totpFactors, users } from '../../database/schema.js'
import type { ExistingUser, SeedStore } from './run-seed.js'

type SeedDb = Pick<NodePgDatabase, 'insert' | 'select' | 'execute'>

export function createDrizzleSeedStore(db: SeedDb): SeedStore {
    return {
        async insertPromptIfMissing(prompt): Promise<boolean> {
            const rows = await db
                .insert(llmSystemPrompts)
                .values(prompt)
                .onConflictDoNothing({ target: llmSystemPrompts.type })
                .returning({ id: llmSystemPrompts.id })
            return rows.length > 0
        },

        // Matches the partial unique index users_email_unique_non_null_idx on LOWER(email).
        async findUserByEmail(normalizedEmail): Promise<ExistingUser | undefined> {
            const [row] = await db
                .select({ id: users.id, role: users.role })
                .from(users)
                .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
                .limit(1)
            return row
        },

        async insertUser(user): Promise<RecordedAuditEvent[]> {
            const [row] = await db
                .insert(users)
                .values({
                    name: user.name,
                    email: normalizeEmail(user.email),
                    password: user.passwordHash,
                    role: user.role,
                    emailVerifiedAt: new Date(),
                })
                .returning({ id: users.id })
            if (row === undefined) throw new Error('Seed user was not inserted')
            if (user.totpSecret !== undefined) {
                // feat-247: sealed as the TOTP setup seals it, bound to the new user's id.
                const box = mfaSecretBox()
                if (box === null) throw new Error('No MFA key seals the seed TOTP secret')
                const sealed = box.seal(user.totpSecret, totpSecretOwner(row.id))
                await db.insert(totpFactors).values({
                    userId: row.id,
                    enrollmentId: randomUUID().replaceAll('-', ''),
                    secretCiphertext: sealed.ciphertext,
                    keyId: sealed.keyId,
                    lastUsedStep: 0n,
                    confirmedAt: new Date(),
                })
            }
            if (user.role !== 'admin') return []
            // feat-235: who holds the admin role, and since when; in the seed's own transaction.
            const tx = db as unknown as DbTransaction
            const stamp = await auditService.stamp(tx)
            return auditService.record(tx, stamp, systemActor('seed'), [
                {
                    action: 'user.admin.created',
                    targetId: String(row.id),
                    targetUserId: row.id,
                    input: {},
                },
            ])
        },
    }
}
