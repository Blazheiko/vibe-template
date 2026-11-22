import { describe, expect, it } from 'vitest'

import { parseUserMfaResetArgs } from './user-mfa-reset-args.js'

describe('user:mfa-reset arguments (feat-247)', () => {
    it('takes an email and a reason, in any order', () => {
        expect(parseUserMfaResetArgs(['--email', 'a@b.test', '--reason', ' lost phone '])).toEqual({
            email: 'a@b.test',
            reason: 'lost phone',
        })
        expect(parseUserMfaResetArgs(['--reason', 'lost phone', '--email', 'a@b.test'])).toEqual({
            email: 'a@b.test',
            reason: 'lost phone',
        })
    })

    it.each([
        [[], /No --email/],
        [['--email', 'a@b.test'], /--reason must be/],
        [['--email', 'a@b.test', '--reason', 'no'], /--reason must be/],
        [['--email', 'a@b.test', '--reason', 'x'.repeat(201)], /--reason must be/],
        [['--email', '--reason', 'lost'], /--email needs a value/],
        [['--email', 'a@b.test', '--reason', 'lost', '--force'], /Unknown argument "--force"/],
    ])('refuses %j', (args, message) => {
        expect(() => parseUserMfaResetArgs(args)).toThrow(message)
    })
})
