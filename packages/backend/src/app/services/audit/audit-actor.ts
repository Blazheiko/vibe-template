import type { Logger } from 'pino'
import type { AuditProof, AuditSystemSource } from 'shared/audit'

import logger from '#logger'
import type { UserRow } from '#app/repositories/index.js'

export type AuditActorRole = UserRow['role']

/** What an actor's logger must do: the committed events are logged at info. */
export type AuditLogger = Pick<Logger, 'info'>

/**
 * Who made a change (feat-235, Р6), passed down explicitly from the controller (the project has no
 * AsyncLocalStorage). `logger` is the one the committed event is logged with: for HTTP the request
 * logger, which carries the request id.
 *
 * - `user`: a signed-in session; `proof` is the one-time proof the action also required
 *   (an e-mail link, an SMS code), if any.
 * - `proof_holder`: no session of the account, only a proof; the log knows the target account,
 *   not who held the proof.
 * - `system`: the seed or a CLI, no request.
 */
export type AuditActor =
    | {
          kind: 'user'
          userId: bigint
          role: AuditActorRole | null
          requestId: string
          proof: AuditProof | null
          source: null
          logger: AuditLogger
      }
    | {
          kind: 'proof_holder'
          userId: null
          role: null
          requestId: string
          proof: AuditProof
          source: null
          logger: AuditLogger
      }
    | {
          kind: 'system'
          userId: null
          role: null
          requestId: null
          proof: null
          source: AuditSystemSource
          logger: AuditLogger
      }

export type UserAuditActor = Extract<AuditActor, { kind: 'user' }>
export type ProofHolderAuditActor = Extract<AuditActor, { kind: 'proof_holder' }>
export type SystemAuditActor = Extract<AuditActor, { kind: 'system' }>

/** A change made by the system itself: no request, no user. */
export function systemActor(
    source: AuditSystemSource,
    log: AuditLogger = logger,
): SystemAuditActor {
    return {
        kind: 'system',
        userId: null,
        role: null,
        requestId: null,
        proof: null,
        source,
        logger: log,
    }
}

/** The same signed-in actor, with the one-time proof its action also required. */
export function withProof(actor: UserAuditActor, proof: AuditProof): UserAuditActor {
    return { ...actor, proof }
}

/** The same signed-in actor, with the role read from the row the service already locked. */
export function withRole(actor: UserAuditActor, role: AuditActorRole): UserAuditActor {
    return { ...actor, role }
}

/**
 * The request a service acts for, when it learns the actor itself (feat-235): the e-mail link
 * knows its account only once the link is found, an OAuth callback once the provider answered.
 */
export interface AuditRequest {
    requestId: string
    logger: AuditLogger
}

/** The signed-in user `userId` of `request`. */
export function userActorOf(userId: bigint, request: AuditRequest): UserAuditActor {
    return {
        kind: 'user',
        userId,
        role: null,
        requestId: request.requestId,
        proof: null,
        source: null,
        logger: request.logger,
    }
}

/** The holder of `proof` in `request`. */
export function proofHolderOf(proof: AuditProof, request: AuditRequest): ProofHolderAuditActor {
    return {
        kind: 'proof_holder',
        userId: null,
        role: null,
        requestId: request.requestId,
        proof,
        source: null,
        logger: request.logger,
    }
}
