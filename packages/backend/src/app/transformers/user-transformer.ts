import type { UserRow } from '#app/repositories/index.js'
import { toIsoDateTimeOrNull, type EntityId, type IsoDateTime } from 'shared/brand'
import { toEntityId } from '#app/domain/ids.js'

export type SerializedUser = Omit<
    UserRow,
    | 'id'
    | 'password'
    | 'sessionToken'
    | 'webauthnUserHandle'
    | 'createdAt'
    | 'updatedAt'
    | 'emailVerifiedAt'
> & {
    id: EntityId
    created_at: string | null
    updated_at: string | null
    emailVerified: boolean
    emailVerifiedAt: IsoDateTime | null
}

export const userTransformer = {
    serialize(user: UserRow): SerializedUser {
        // sessionToken is the user's Redis session namespace and part of the signed cookie:
        // the client never needs it, and readable from JS it would only help an XSS.
        const {
            id,
            password: _password,
            sessionToken: _sessionToken,
            // feat-246: the WebAuthn user.id is told to the authenticator only, never to the page.
            webauthnUserHandle: _webauthnUserHandle,
            createdAt,
            updatedAt,
            emailVerifiedAt,
            ...rest
        } = user
        return {
            ...rest,
            id: toEntityId(id),
            created_at: createdAt.toISOString(),
            updated_at: updatedAt.toISOString(),
            emailVerified: emailVerifiedAt !== null,
            emailVerifiedAt: toIsoDateTimeOrNull(emailVerifiedAt),
        }
    },

    serializeArray(usersData: UserRow[]): SerializedUser[] {
        return usersData.map((u) => userTransformer.serialize(u))
    },
}
