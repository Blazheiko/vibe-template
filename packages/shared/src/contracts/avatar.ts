import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type { DeleteAvatarResponse, UploadAvatarResponse } from '../responses/avatar-controller.js'
import { contract, multipartContract } from './core.js'

export const avatarContracts = {
    // One file under `avatar`; the server checks its type and size (AVATAR_MAX_FILE_BYTES).
    upload: multipartContract<
        typeof EmptyFormInputSchema.inferIn,
        'avatar',
        UploadAvatarResponse
    >()('post', '/avatar/upload'),
    remove: contract<undefined, undefined, DeleteAvatarResponse>()('delete', '/avatar'),
} as const
