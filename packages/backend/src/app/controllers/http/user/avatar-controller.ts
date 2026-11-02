import type { HttpContext } from '#vendor/types/types.js'
import { avatarService } from '#app/services/user/avatar-service.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { unauthorized } from '#app/services/shared/errors.js'
import type { EmptyFormInput } from 'shared/schemas'
import type { UploadAvatarResponse, DeleteAvatarResponse } from 'shared/responses'

export default {
    async uploadAvatar(context: HttpContext<EmptyFormInput>): Promise<UploadAvatarResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const file = context.httpData.files?.get('avatar')
        const result = await avatarService.uploadAvatar(userId, file)
        return respond(context, result, (value) => ({ status: 'ok', user: value.user }))
    },

    async deleteAvatar(context: HttpContext): Promise<DeleteAvatarResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await avatarService.deleteAvatar(userId)
        return respond(context, result, (value) => ({ status: 'ok', user: value.user }))
    },
}
