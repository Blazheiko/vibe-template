import { parseUserAgent } from 'shared/utils'
import { asIsoDateTime, asSessionPublicId } from '#app/domain/wire.js'
import { toIsoDateTime } from 'shared/brand'
import type { SessionView } from 'shared'
import type { SessionDevice } from '#vendor/types/types.js'

export interface SessionViewSource {
    device: SessionDevice
    lastSeenAtMs: number | null
    current: boolean
    online: boolean
}

export const sessionTransformer = {
    /** feat-233 (Р6, Р7): the device is parsed here, at read time; the raw User-Agent goes along. */
    serialize({ device, lastSeenAtMs, current, online }: SessionViewSource): SessionView {
        const { browser, os, deviceType } = parseUserAgent(device.userAgent)
        return {
            id: asSessionPublicId(device.publicId),
            current,
            browser,
            os,
            deviceType,
            userAgent: device.userAgent,
            ip: device.ip,
            method: device.method,
            provider: device.provider ?? null,
            signedInAt: asIsoDateTime(device.signedInAt),
            lastSeenAt:
                lastSeenAtMs !== null && Number.isFinite(lastSeenAtMs)
                    ? toIsoDateTime(new Date(lastSeenAtMs))
                    : null,
            online,
        }
    },
}
