import { describe, expect, it } from 'vitest'

import { canonicalPushEndpoint, isAllowedPushEndpoint } from './push-endpoint-policy.js'

// feat-104 (R03): the hosts are the defaults of config/push.ts.
const ALLOWED = [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    '.notify.windows.com',
    'web.push.apple.com',
]

describe('isAllowedPushEndpoint', () => {
    it.each([
        'https://fcm.googleapis.com/fcm/send/abc:def',
        'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
        'https://wns2-par02p.notify.windows.com/w/?token=abc',
        'https://web.push.apple.com/QGv7',
        'https://FCM.GOOGLEAPIS.COM./fcm/send/x',
        'https://fcm.googleapis.com:443/fcm/send/x',
    ])('accepts %s', (endpoint) => {
        expect(isAllowedPushEndpoint(endpoint, ALLOWED)).toBe(true)
    })

    it.each([
        ['plain http', 'http://fcm.googleapis.com/fcm/send/x'],
        ['private IPv4', 'https://10.0.0.5/admin'],
        ['loopback IPv6', 'https://[::1]/x'],
        ['metadata service', 'https://169.254.169.254/latest/meta-data'],
        ['decimal IPv4', 'https://2130706433/x'],
        ['credentials', 'https://user@fcm.googleapis.com/fcm/send/x'],
        ['credentials with password', 'https://user:pw@fcm.googleapis.com/fcm/send/x'],
        ['other port', 'https://fcm.googleapis.com:8443/fcm/send/x'],
        ['host in the path', 'https://evil.com/fcm.googleapis.com'],
        ['suffix without a label boundary', 'https://evilnotify.windows.com/x'],
        ['suffix entry itself is not a host', 'https://notify.windows.com/x'],
        ['allowed host as a subdomain of another', 'https://fcm.googleapis.com.evil.io/x'],
        ['exact entry does not allow subdomains', 'https://a.fcm.googleapis.com/x'],
        ['not a URL', 'fcm.googleapis.com/fcm/send/x'],
        ['empty', ''],
        ['other scheme', 'wss://fcm.googleapis.com/x'],
    ])('rejects %s', (_label, endpoint) => {
        expect(isAllowedPushEndpoint(endpoint, ALLOWED)).toBe(false)
    })

    it('compares an internationalized host in its ASCII form', () => {
        expect(isAllowedPushEndpoint('https://bücher.example/x', ['xn--bcher-kva.example'])).toBe(
            true,
        )
    })
})

// feat-125: the stored form of an endpoint.
describe('canonicalPushEndpoint', () => {
    it.each([
        ['https://FCM.GOOGLEAPIS.COM./fcm/send/abc', 'https://fcm.googleapis.com/fcm/send/abc'],
        ['https://fcm.googleapis.com:443/fcm/send/abc', 'https://fcm.googleapis.com/fcm/send/abc'],
        [
            'https://fcm.googleapis.com/fcm/send/AbC?x=1',
            'https://fcm.googleapis.com/fcm/send/AbC?x=1',
        ],
    ])('%s is stored as %s', (endpoint, canonical) => {
        expect(canonicalPushEndpoint(endpoint)).toBe(canonical)
    })

    it('is null for an endpoint that is not allowed', () => {
        expect(canonicalPushEndpoint('https://evil.example/fcm/send/abc')).toBeNull()
        expect(canonicalPushEndpoint('not a url')).toBeNull()
    })
})

// feat-130 (fifth review): path and query used to be kept as given, so the same endpoint spelled
// with an escaped unreserved character or a lower-case escape was a second endpoint, and a leaked
// one passed the "belongs to another user" check. RFC 3986 §6.2.2 normalization makes them one.
describe('canonicalPushEndpoint percent-encoding (feat-130)', () => {
    const allowed = ['fcm.googleapis.com', '.notify.windows.com']

    it.each([
        ['https://fcm.googleapis.com/fcm/send/%41bc', 'https://fcm.googleapis.com/fcm/send/Abc'],
        [
            'https://fcm.googleapis.com/fcm/send/a%2db%5Fc%7E',
            'https://fcm.googleapis.com/fcm/send/a-b_c~',
        ],
        ['https://fcm.googleapis.com/fcm/send/a%2fb', 'https://fcm.googleapis.com/fcm/send/a%2Fb'],
        ['https://fcm.googleapis.com/fcm/send/a%3ab', 'https://fcm.googleapis.com/fcm/send/a%3Ab'],
        [
            'https://db5p.notify.windows.com/w/?token=AB%3d%3d',
            'https://db5p.notify.windows.com/w/?token=AB%3D%3D',
        ],
    ])('%s → %s', (endpoint, canonical) => {
        expect(canonicalPushEndpoint(endpoint, allowed)).toBe(canonical)
    })

    it('two spellings of one endpoint are one', () => {
        expect(canonicalPushEndpoint('https://FCM.googleapis.com./fcm/send/%4a', allowed)).toBe(
            canonicalPushEndpoint('https://fcm.googleapis.com/fcm/send/J', allowed),
        )
    })
})
