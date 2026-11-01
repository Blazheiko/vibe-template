import { apiPath } from '@/utils/api-path'

export interface StorageConfig {
    cdnUrl: string
    s3Prefix: string
    s3StaticDataPrefix: string
    s3DynamicDataPrefix: string
}

const normalizeUrl = (value: string): string => {
    if (!value) return ''
    return value.endsWith('/') ? value.slice(0, -1) : value
}

const normalizePathSegment = (value: string): string => {
    return value.trim().replace(/^\/+|\/+$/g, '')
}

const hasPathPrefix = (value: string, prefix: string): boolean => {
    if (!value || !prefix) return false
    return value === prefix || value.startsWith(`${prefix}/`)
}

/**
 * The URL a stored file is shown from: an absolute address as it is, otherwise the path under the
 * configured prefixes (the dynamic-data one, then the root one, each added once), on the CDN when
 * there is one and on the API's own storage route when there is not.
 */
export const getStorageFileUrl = (config: StorageConfig, src: string): string => {
    if (src.startsWith('http://') || src.startsWith('https://')) {
        return src
    }

    const cleanSrc = src.trim().replace(/^\/+/, '')
    const dynamicPrefix = normalizePathSegment(config.s3DynamicDataPrefix)
    const rootPrefix = normalizePathSegment(config.s3Prefix)
    let fullPath = cleanSrc

    if (dynamicPrefix && !hasPathPrefix(fullPath, dynamicPrefix)) {
        fullPath = `${dynamicPrefix}/${fullPath}`
    }
    if (rootPrefix && !hasPathPrefix(fullPath, rootPrefix)) {
        fullPath = `${rootPrefix}/${fullPath}`
    }

    const cdnUrl = config.cdnUrl.trim()

    if (cdnUrl) {
        const base = normalizeUrl(cdnUrl)
        return `${base}/${fullPath}`
    }

    // Same origin without VITE_BASE_URL, as in base-api.ts (code-issues item 59).
    const apiBase = normalizeUrl(import.meta.env.VITE_BASE_URL ?? '')
    return `${apiBase}${apiPath(`storage/${fullPath}`)}`
}
