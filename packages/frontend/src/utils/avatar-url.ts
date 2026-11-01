import { useStateStore } from '@/stores/state'
import { getStorageFileUrl } from '@/utils/storage-url'

export function buildAvatarUrl(avatarKey: string | null | undefined): string | null {
    if (!avatarKey) {
        return null
    }

    const stateStore = useStateStore()
    const config = stateStore.storageConfig
    if (!config.cdnUrl) {
        return null
    }

    return getStorageFileUrl(config, avatarKey)
}
