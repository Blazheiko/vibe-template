import { type } from '@arktype/type'

import { ROLES } from './index.js'

/** A role of the catalog (feat-240), for the response and event schemas. */
export const RoleSchema = type.enumerated(...ROLES)
