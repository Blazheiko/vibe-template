// What a push subscription tells the server about the device and its key, taken from the user
// agent. The server stores `browserName`, `osName` and `deviceType` (columns of
// `push_subscriptions`), so these functions are part of a contract: what they answer is what is
// recorded. They answer as they always did, quirks included (see push-device.spec.ts).

export interface NameAndVersion {
    name: string
    version: string
}

export const getDeviceType = (userAgent: string): string => {
    if (/mobile|android|iphone|ipad|tablet/.test(userAgent.toLowerCase())) {
        return 'mobile'
    }
    return 'desktop'
}

export const getBrowserInfo = (userAgent: string): NameAndVersion => {
    const userAgentLower = userAgent.toLowerCase()

    let browserName = 'Unknown'
    let browserVersion = 'Unknown'

    if (userAgentLower.includes('chrome') && !userAgentLower.includes('edg')) {
        browserName = 'Chrome'
        const match = /Chrome\/(\d+\.\d+)/.exec(userAgent)
        browserVersion = match ? match[1] : 'Unknown'
    } else if (userAgentLower.includes('firefox')) {
        browserName = 'Firefox'
        const match = /Firefox\/(\d+\.\d+)/.exec(userAgent)
        browserVersion = match ? match[1] : 'Unknown'
    } else if (userAgentLower.includes('safari') && !userAgentLower.includes('chrome')) {
        browserName = 'Safari'
        const match = /Version\/(\d+\.\d+)/.exec(userAgent)
        browserVersion = match ? match[1] : 'Unknown'
    } else if (userAgentLower.includes('edg')) {
        browserName = 'Edge'
        const match = /Edg\/(\d+\.\d+)/.exec(userAgent)
        browserVersion = match ? match[1] : 'Unknown'
    }

    return { name: browserName, version: browserVersion }
}

export const getOSInfo = (userAgent: string): NameAndVersion => {
    let osName = 'Unknown'
    let osVersion = 'Unknown'

    if (userAgent.includes('Windows NT')) {
        osName = 'Windows'
        const match = /Windows NT (\d+\.\d+)/.exec(userAgent)
        osVersion = match ? match[1] : 'Unknown'
    } else if (userAgent.includes('Mac OS X')) {
        osName = 'macOS'
        const match = /Mac OS X (\d+[._]\d+[._]?\d*)/.exec(userAgent)
        osVersion = match ? match[1].replace(/_/g, '.') : 'Unknown'
    } else if (userAgent.includes('Linux')) {
        osName = 'Linux'
        osVersion = 'Unknown'
    } else if (userAgent.includes('Android')) {
        osName = 'Android'
        const match = /Android (\d+\.\d+)/.exec(userAgent)
        osVersion = match ? match[1] : 'Unknown'
    } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
        osName = 'iOS'
        const match = /OS (\d+[._]\d+[._]?\d*)/.exec(userAgent)
        osVersion = match ? match[1].replace(/_/g, '.') : 'Unknown'
    }

    return { name: osName, version: osVersion }
}

/** A VAPID public key as the push service wants it: base64url text to bytes. */
export const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')

    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
}

/** A subscription key (an ArrayBuffer) as base64 text; empty when there is none. */
export const arrayBufferToBase64 = (buffer: ArrayBuffer | null): string => {
    if (!buffer) return ''
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return window.btoa(binary)
}

/** Whether a key from the server can be a real VAPID public key (not unset, not the placeholder). */
export const isValidVapidKey = (key: string | null): key is string => {
    if (!key) return false
    if (key === 'YOUR_VAPID_PUBLIC_KEY_HERE') return false
    if (key.length < 80) return false // VAPID keys are longer
    return true
}
