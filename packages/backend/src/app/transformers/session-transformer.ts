import { parseUserAgent } from 'shared/utils'
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
            id: device.publicId,
            current,
            browser,
            os,
            deviceType,
            userAgent: device.userAgent,
            ip: device.ip,
            method: device.method,
            provider: device.provider ?? null,
            signedInAt: device.signedInAt,
            lastSeenAt:
                lastSeenAtMs !== null && Number.isFinite(lastSeenAtMs)
                    ? new Date(lastSeenAtMs).toISOString()
                    : null,
            online,
        }
    },
}
