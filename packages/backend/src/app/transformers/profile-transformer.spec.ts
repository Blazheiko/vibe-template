import { describe, expect, it } from 'vitest'

import { profileTransformer } from './profile-transformer.js'

const row = (fields: Record<string, unknown> = {}) =>
    ({
        userId: 7n,
        locale: 'uk',
        timeZone: 'Europe/Kiev',
        theme: 'dark',
        colorTheme: 'mint',
        fontSize: 18,
        revision: 42n,
        updatedAt: new Date('2026-11-19T00:00:00Z'),
        ...fields,
    }) as Parameters<typeof profileTransformer.serialize>[1]

describe('profileTransformer (feat-232)', () => {
    it('no row: every preference null and revision "0"', () => {
        expect(profileTransformer.serialize('Ann', undefined)).toEqual({
            name: 'Ann',
            preferences: {
                locale: null,
                timeZone: null,
                theme: null,
                colorTheme: null,
                fontSize: null,
            },
            revision: '0',
        })
    })

    it('a row: its values, revision as a decimal string, no internal fields', () => {
        const profile = profileTransformer.serialize('Ann', row())
        expect(profile).toEqual({
            name: 'Ann',
            preferences: {
                locale: 'uk',
                timeZone: 'Europe/Kiev',
                theme: 'dark',
                colorTheme: 'mint',
                fontSize: 18,
            },
            revision: '42',
        })
        expect(Object.keys(profile).sort()).toEqual(['name', 'preferences', 'revision'])
    })

    it('a stored value the code no longer accepts reads as null', () => {
        expect(
            profileTransformer.serializePreferences(
                row({ locale: 'de', timeZone: 'Mars/Base', colorTheme: 'gone', fontSize: 30 }),
            ),
        ).toEqual({ locale: null, timeZone: null, theme: 'dark', colorTheme: null, fontSize: null })
    })

    it('keeps a revision past Number.MAX_SAFE_INTEGER exact', () => {
        expect(
            profileTransformer.serialize('Ann', row({ revision: 9007199254740993n })).revision,
        ).toBe('9007199254740993')
    })
})
