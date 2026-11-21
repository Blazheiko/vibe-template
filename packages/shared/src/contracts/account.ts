import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type { UpdateProfileInputSchema } from '../schemas/account/update-profile.js'
import type { ListSessionsQueryInput } from '../schemas/query/account-sessions.js'
import type {
    GetAccessResponse,
    GetProfileResponse,
    UpdateProfileResponse,
} from '../responses/account-controller.js'
import type {
    ListSessionsResponse,
    RevokeOtherSessionsResponse,
    RevokeSessionResponse,
} from '../responses/account-sessions-controller.js'
import { contract } from './core.js'

export const accountContracts = {
    getProfile: contract<undefined, undefined, GetProfileResponse>()('get', '/account/profile'),
    // feat-240 (Р8): the current role, read again on reconnect and when the tab is shown.
    getAccess: contract<undefined, undefined, GetAccessResponse>()('get', '/account/access'),
    // Partial body: an absent field is unchanged, `null` resets a preference (feat-232, Р2).
    updateProfile: contract<
        typeof UpdateProfileInputSchema.inferIn,
        undefined,
        UpdateProfileResponse
    >()('patch', '/account/profile'),
    // feat-233 (Р7): the current session apart, then pages of the others, newest first.
    listSessions: contract<undefined, ListSessionsQueryInput, ListSessionsResponse>()(
        'get',
        '/account/sessions',
    ),
    // Ends one other session; the current one answers 409 `current_session`.
    revokeSession: contract<undefined, undefined, RevokeSessionResponse>()(
        'delete',
        '/account/sessions/:id',
    ),
    // Ends every session but this one, which is renewed (Р9).
    revokeOtherSessions: contract<
        typeof EmptyFormInputSchema.inferIn,
        undefined,
        RevokeOtherSessionsResponse
    >()('post', '/account/sessions/revoke-others'),
} as const
