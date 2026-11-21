import { describe, expect, it } from 'vitest'

import { parseUserSetRoleArgs } from './user-set-role-args.js'

describe('user:set-role arguments (feat-240)', () => {
    it('takes an email and a role of the catalog, in any order', () => {
        expect(parseUserSetRoleArgs(['--email', 'a@b.test', '--role', 'kb_editor'])).toEqual({
            email: 'a@b.test',
            role: 'kb_editor',
        })
        expect(parseUserSetRoleArgs(['--role', 'user', '--email', 'a@b.test'])).toEqual({
            email: 'a@b.test',
            role: 'user',
        })
    })

    it.each([
        [[], /No --email/],
        [['--email', 'a@b.test'], /No --role/],
        [['--role', 'admin'], /No --email/],
        [['--email', 'a@b.test', '--role', 'root'], /Unknown role "root"/],
        [['--email', '--role', 'admin'], /--email needs a value/],
        [['--email', 'a@b.test', '--role'], /--role needs a value/],
        [['--email', 'a@b.test', '--email', 'c@d.test', '--role', 'user'], /twice/],
        [['--email', 'a@b.test', '--role', 'user', '--force'], /Unknown argument "--force"/],
        [['a@b.test', 'admin'], /Unknown argument/],
    ])('refuses %j', (args, message) => {
        expect(() => parseUserSetRoleArgs(args)).toThrow(message)
    })
})
