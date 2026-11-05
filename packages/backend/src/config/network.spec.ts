import { describe, expect, it } from 'vitest'

import { readNetworkConfig } from './network.js'

// feat-132 (P2): a malformed TRUSTED_PROXY_CIDRS entry used to be read leniently; `10.0.0.0/`
// was /0 and trusted every client. It is now a configuration error, which stops the start.
describe('readNetworkConfig TRUSTED_PROXY_CIDRS (feat-132)', () => {
    it('accepts addresses and CIDRs', () => {
        const config = readNetworkConfig({
            TRUST_PROXY: 'true',
            TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 127.0.0.1, 2001:db8::/32, ::ffff:a00:0/104',
        })
        expect(config.trustedProxyCidrs).toEqual([
            '10.0.0.0/8',
            '127.0.0.1',
            '2001:db8::/32',
            '::ffff:a00:0/104',
        ])
        expect(config.configError).toBeNull()
    })

    it.each(['10.0.0.0/', '10.0.0.0/ 0', '10.0.0.0/.0', '10.0.0.0/33', 'proxy.internal'])(
        'reports %j as a configuration error',
        (entry) => {
            const config = readNetworkConfig({ TRUSTED_PROXY_CIDRS: `127.0.0.1, ${entry}` })
            expect(config.configError).toContain('TRUSTED_PROXY_CIDRS')
            expect(config.configError).toContain(JSON.stringify(entry.trim()))
        },
    )

    it('still reports a malformed boolean', () => {
        expect(readNetworkConfig({ TRUST_PROXY: 'maybe' }).configError).not.toBeNull()
    })
})
