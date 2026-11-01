import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThrottlePolicy } from './throttle-policies.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    vi.resetModules()
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
})

const load = async () => import('./throttle-policies.js')

const policy = (overrides: Partial<ThrottlePolicy>): ThrottlePolicy => ({
    scope: 's',
    keyBy: 'ip',
    algorithm: 'fixed-window',
    limit: 1,
    windowMs: 1000,
    onRedisError: 'reject',
    ...overrides,
})

describe('throttlePolicies registry', () => {
    it('is valid with default configuration', async () => {
        const { throttlePolicies, validateThrottlePolicies, throttlePolicyConfigError } =
            await load()
        expect(throttlePolicyConfigError).toBeNull()
        expect(validateThrottlePolicies(throttlePolicies)).toEqual([])
    })

    it('keeps the scopes, limits and windows of the pre-registry calls and the confirmed new policies', async () => {
        const { throttlePolicies: p } = await load()
        const HOUR = 3_600_000
        const table = Object.fromEntries(
            Object.values(p).map((x) => [x.scope, [x.limit, x.windowMs, x.keyBy]]),
        )
        expect(table).toEqual({
            register_email_ip: [10, HOUR, 'ip'],
            register_email_identifier: [3, HOUR, 'email'],
            register_phone_ip: [10, HOUR, 'ip'],
            sms_send_phone: [3, HOUR, 'phone'],
            confirm_phone_ip: [20, HOUR, 'ip'],
            reset_phone_ip: [10, HOUR, 'ip'],
            confirm_reset_phone_ip: [20, HOUR, 'ip'],
            link_phone_ip: [10, HOUR, 'ip'],
            confirm_link_phone_ip: [20, HOUR, 'ip'],
            link_email_target: [3, HOUR, 'email'],
            link_email_user: [3, HOUR, 'user'],
            link_email_user_cooldown: [1, 60_000, 'user'],
            upgrade: [60, 60_000, 'ip'],
            login_ip: [20, 900_000, 'ip'],
            login_identifier: [40, 900_000, 'identifier'],
            change_password_user: [10, 900_000, 'user'],
            forgot_password_ip: [10, HOUR, 'ip'],
            forgot_password_email: [3, HOUR, 'email'],
            resend_verification_user: [3, HOUR, 'user'],
            reset_password_ip: [20, HOUR, 'ip'],
            verify_email_ip: [20, HOUR, 'ip'],
            support_chat_user: [20, 60_000, 'user'],
            support_open_chat_user: [5, 60_000, 'user'],
            login_unverified_resend: [1, 300_000, 'user'],
        })
    })

    it('flags duplicate scopes', async () => {
        const { validateThrottlePolicies } = await load()
        expect(
            validateThrottlePolicies({
                a: policy({ scope: 'x' }),
                b: policy({ scope: 'x' }),
            }),
        ).toEqual(['b: duplicate scope "x"'])
    })

    it('allows limit 0 only for disableable policies', async () => {
        const { validateThrottlePolicies } = await load()
        expect(validateThrottlePolicies({ a: policy({ limit: 0 }) })).toHaveLength(1)
        expect(validateThrottlePolicies({ a: policy({ limit: 0, disableable: true }) })).toEqual([])
    })

    it('rejects non-positive windows', async () => {
        const { validateThrottlePolicies } = await load()
        expect(validateThrottlePolicies({ a: policy({ windowMs: 0 }) })).toHaveLength(1)
    })

    it('turns 0 from env for an auth policy into a startup config error', async () => {
        process.env['AUTH_SMS_MAX_SENDS_PER_PHONE_PER_HOUR'] = '0'
        const { throttlePolicyConfigError } = await load()
        expect(throttlePolicyConfigError).toContain('smsSendPhone: limit must be')
    })
})

describe('consumeAuthThrottle call sites', () => {
    it('pass a registry policy, never an inline options object', async () => {
        const dir = path.join(import.meta.dirname, '../app/services')
        const files = (await fs.readdir(dir, { recursive: true })).filter(
            (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts'),
        )
        const offenders: string[] = []
        for (const file of files) {
            const source = await fs.readFile(path.join(dir, file), 'utf8')
            if (/consumeAuthThrottle\(\s*\{/.test(source)) offenders.push(file)
            for (const m of source.matchAll(/consumeAuthThrottle\(\s*([\w.]+)/g)) {
                const arg = m[1] ?? ''
                if (arg !== 'policy' && !arg.startsWith('throttlePolicies.'))
                    offenders.push(`${file}: ${arg}`)
            }
        }
        expect(offenders).toEqual([])
    })
})
