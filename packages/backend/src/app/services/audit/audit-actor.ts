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
          requestId: string | null
          proof: AuditProof | null
          source: null
          logger: AuditLogger
      }
    | {
          kind: 'proof_holder'
          userId: null
          role: null
          requestId: string | null
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

/** A change made by the system itself: no request, no user. */
export function systemActor(source: AuditSystemSource, log: AuditLogger = logger): AuditActor {
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
 * The signed-in user of a call made without a request (a script, a test of the service): the
 * event is written all the same, without a request id. Controllers pass `auditActorFrom(context)`.
 */
export function userActorWithoutRequest(userId: bigint): UserAuditActor {
    return {
        kind: 'user',
        userId,
        role: null,
        requestId: null,
        proof: null,
        source: null,
        logger,
    }
}

/** A proof holder of a call made without a request; see `userActorWithoutRequest`. */
export function proofHolderWithoutRequest(proof: AuditProof): ProofHolderAuditActor {
    return {
        kind: 'proof_holder',
        userId: null,
        role: null,
        requestId: null,
        proof,
        source: null,
        logger,
    }
}

/** The request a service acts for, when it learns the actor itself (feat-235). */
export interface AuditRequest {
    requestId: string | null
    logger: AuditLogger
}

/** The signed-in user `userId` of `request` (the e-mail link: the account is known once found). */
export function userActorOf(userId: bigint, request: AuditRequest | undefined): UserAuditActor {
    return request === undefined
        ? userActorWithoutRequest(userId)
        : {
              ...userActorWithoutRequest(userId),
              requestId: request.requestId,
              logger: request.logger,
          }
}

/** The proof holder of `request`; see `userActorOf`. */
export function proofHolderOf(
    proof: AuditProof,
    request: AuditRequest | undefined,
): ProofHolderAuditActor {
    return request === undefined
        ? proofHolderWithoutRequest(proof)
        : {
              ...proofHolderWithoutRequest(proof),
              requestId: request.requestId,
              logger: request.logger,
          }
}
