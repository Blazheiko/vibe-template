import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { productionProblem } from '../urls'

/**
 * One case table through both validators of a production address: productionProblem
 * (build/urls.ts, the build) and `--check-address` of scripts/verify-landing-deploy.sh (a deployed
 * site). They must give the same answer, word for word, or a page could pass one and fail the other.
 */

const SCRIPT = fileURLToPath(
    new URL('../../../../scripts/verify-landing-deploy.sh', import.meta.url),
)

const CASES: readonly (readonly [string, string | null])[] = [
    ['https://app.vibe.dev/login', null],
    ['https://APP.vibe.dev/login', null],
    ['HTTPS://app.vibe.dev/', null],
    ['https://app.vibe.dev:8443/x?y=1#z', null],
    ['https://app.vibe.dev./', null],
    ['https://xn--80ak6aa92e.com/', null],
    ['http://app.vibe.dev/', 'must use https'],
    ['ftp://app.vibe.dev/', 'must use https'],
    ['//app.vibe.dev/', 'must use https'],
    ['https:///login', 'has no host'],
    ['https://app.vibe.dev:99999/', 'has an invalid port'],
    ['https://app.vibe.dev:8a/', 'has an invalid port'],
    // IP literals in every form a URL parser accepts.
    ['https://[::1]/login', 'is an IP address, not a domain name'],
    ['https://[2001:db8::1]:443/', 'is an IP address, not a domain name'],
    ['https://127.0.0.1/', 'is an IP address, not a domain name'],
    ['https://1.2.3.4/', 'is an IP address, not a domain name'],
    ['https://2130706433/login', 'is an IP address, not a domain name'],
    ['https://0x7f000001/', 'is an IP address, not a domain name'],
    ['https://0177.0.0.1/', 'is an IP address, not a domain name'],
    ['https://127.1/', 'is an IP address, not a domain name'],
    ['https://app.vibe.123/', 'is an IP address, not a domain name'],
    // Hosts a URL parser rewrites into another name.
    ['https://local%68ost/', 'is not a plain ASCII domain name'],
    ['https://ｌｏｃａｌｈｏｓｔ/', 'is not a plain ASCII domain name'],
    ['https://bücher.de/', 'is not a plain ASCII domain name'],
    ['https://evil.com\\@localhost/', 'is not a plain URL'],
    ['https://app.vibe.dev /', 'is not a plain URL'],
    ['https://app.vibe.dev/\tx', 'is not a plain URL'],
    // Local and reserved names.
    ['https://localhost/', 'points to the local machine'],
    ['https://user:pw@localhost:443/', 'points to the local machine'],
    ['https://LOCALHOST./', 'points to the local machine'],
    ['https://app.localhost/', 'points to the local machine'],
    ['https://example.com./', 'is a placeholder domain (RFC 2606)'],
    ['https://app.example.com../', 'is a placeholder domain (RFC 2606)'],
    ['https://example.org/', 'is a placeholder domain (RFC 2606)'],
    ['https://landing.test/', 'is a placeholder domain (RFC 2606)'],
    ['https://app.invalid/', 'is a placeholder domain (RFC 2606)'],
    ['https://myexample.com/', null],
]

const shell = (url: string): string | null => {
    const result = spawnSync('bash', [SCRIPT, '--check-address', url], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const answer = result.stdout.trim()
    return answer === 'ok' ? null : answer
}

describe('the production address rule', () => {
    it.each(CASES)('%s', (url, expected) => {
        expect(productionProblem(url)).toBe(expected)
        expect(shell(url)).toBe(expected)
    })
})
