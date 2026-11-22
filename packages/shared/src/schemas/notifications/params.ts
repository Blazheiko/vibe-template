import { type } from '@arktype/type'
import {
    NOTIFICATION_PARAM_MAX_LENGTH,
    type NotificationKind,
    type NotificationParamsMap,
} from '../../notifications/catalog.js'
import { OAuthProviderSchema } from '../../responses/oauth-controller.js'

// feat-236 (Р2, Р9): what each kind of notification may carry. Only the keys named here, short
// strings; the byte size of the whole is checked by the backend before the row is written.
const Label = type('string').atLeastLength(1).atMostLength(NOTIFICATION_PARAM_MAX_LENGTH)
const None = type({ '+': 'reject' })

export const NotificationParamsSchemas = {
    'security.new_sign_in': type({ device: Label, '+': 'reject' }),
    'security.method_added': type({ provider: OAuthProviderSchema, '+': 'reject' }),
    'security.method_removed': type({ provider: OAuthProviderSchema, '+': 'reject' }),
    'security.password_changed': None,
    'security.password_reset': None,
    'security.logout_all': None,
    'security.session_revoked': type({ 'device?': Label, '+': 'reject' }),
    'security.account_claimed': None,
    'security.mfa_enabled': None,
    'security.mfa_disabled': None,
    'security.recovery_codes_regenerated': None,
    'security.recovery_code_used': None,
    // feat-246 (Р14).
    'security.passkey_added': None,
    'security.passkey_removed': None,
    // feat-247 (Р13).
    'security.mfa_reset': None,
    'support.reply': None,
} as const satisfies Record<NotificationKind, unknown>

// Each schema infers exactly the params type of the catalog: a kind whose schema drifts from
// `NotificationParamsMap` fails to compile here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type SchemaParams = {
    [K in NotificationKind]: (typeof NotificationParamsSchemas)[K]['infer']
}
type AllSame = { [K in NotificationKind]: Same<SchemaParams[K], NotificationParamsMap[K]> }
export type NotificationParamsSchemasMatchCatalog = AllSame[NotificationKind] extends true
    ? true
    : never
export const NOTIFICATION_PARAMS_MATCH_CATALOG: NotificationParamsSchemasMatchCatalog = true
