import { describe, expect, it } from 'vitest'

import { DEFAULT_ALLOWED_ENDPOINT_HOSTS, readPushConfig } from './push.js'

describe('readPushConfig (feat-104)', () => {
    it('defaults to the browser push services and 20 subscriptions per user', () => {
        const config = readPushConfig({})
        expect(config.allowedEndpointHosts).toEqual(DEFAULT_ALLOWED_ENDPOINT_HOSTS)
        expect(config.maxSubscriptionsPerUser).toBe(20)
        expect(config.configError).toBeNull()
    })

    it('reads a host list, lowercased and trimmed', () => {
        const config = readPushConfig({
            PUSH_ALLOWED_ENDPOINT_HOSTS: ' FCM.googleapis.com , .push.example.com ',
            PUSH_MAX_SUBSCRIPTIONS_PER_USER: '5',
        })
        expect(config.allowedEndpointHosts).toEqual(['fcm.googleapis.com', '.push.example.com'])
        expect(config.maxSubscriptionsPerUser).toBe(5)
        expect(config.configError).toBeNull()
    })

    it.each([
        'https://fcm.googleapis.com',
        'fcm.googleapis.com:443',
        '10.0.0.5',
        '*.notify.windows.com',
        'localhost',
        ',',
    ])('reports %s as a configuration error', (value) => {
        const config = readPushConfig({ PUSH_ALLOWED_ENDPOINT_HOSTS: value })
        expect(config.configError).toMatch(/PUSH_ALLOWED_ENDPOINT_HOSTS/)
        expect(config.allowedEndpointHosts).toEqual(DEFAULT_ALLOWED_ENDPOINT_HOSTS)
    })

    it.each(['0', '-1', 'abc'])('reports PUSH_MAX_SUBSCRIPTIONS_PER_USER=%s', (value) => {
        expect(readPushConfig({ PUSH_MAX_SUBSCRIPTIONS_PER_USER: value }).configError).toMatch(
            /PUSH_MAX_SUBSCRIPTIONS_PER_USER/,
        )
    })
})
