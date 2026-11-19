import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    COLOR_THEMES,
    DEFAULT_COLOR_THEME,
    DEFAULT_FONT_SIZE,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    THEMES,
    clampFontSize,
    isColorTheme,
} from '../dist/enums/index.js'
import { ProfileNameSchema, UpdateProfileInputSchema } from '../dist/schemas/index.js'
import { ProfileSchema, InitResponseSchema } from '../dist/responses/index.js'
import { allowedTimeZones, isAllowedTimeZone } from '../dist/utils/index.js'

const isError = (result) => result !== null && typeof result === 'object' && 'summary' in result

const nullPreferences = {
    locale: null,
    timeZone: null,
    theme: null,
    colorTheme: null,
    fontSize: null,
}

test('preference enums: the default color is listed and the font bounds hold the default', () => {
    assert.deepEqual([...THEMES], ['light', 'dark'])
    assert.ok(COLOR_THEMES.includes(DEFAULT_COLOR_THEME))
    assert.equal(isColorTheme(DEFAULT_COLOR_THEME), true)
    assert.equal(isColorTheme('red'), false)
    assert.equal(FONT_SIZE_MIN, 14)
    assert.equal(FONT_SIZE_MAX, 20)
    assert.ok(FONT_SIZE_MIN <= DEFAULT_FONT_SIZE && DEFAULT_FONT_SIZE <= FONT_SIZE_MAX)
    assert.equal(clampFontSize(30), FONT_SIZE_MAX)
    assert.equal(clampFontSize(2), FONT_SIZE_MIN)
    assert.equal(clampFontSize(Number.NaN), DEFAULT_FONT_SIZE)
    assert.equal(clampFontSize('18'), DEFAULT_FONT_SIZE)
})

test('profile name: trimmed, 1-100 characters', () => {
    assert.equal(ProfileNameSchema('  Ann  '), 'Ann')
    assert.ok(isError(ProfileNameSchema('   ')))
    assert.ok(isError(ProfileNameSchema('')))
    assert.equal(ProfileNameSchema('a'.repeat(100)), 'a'.repeat(100))
    assert.ok(isError(ProfileNameSchema('a'.repeat(101))))
    // 100 characters outside the BMP are 200 UTF-16 units and still fit varchar(100).
    assert.equal(ProfileNameSchema('😀'.repeat(100)), '😀'.repeat(100))
    assert.ok(isError(ProfileNameSchema('😀'.repeat(101))))
})

test('profile name: control characters and line breaks are refused', () => {
    for (const name of ['a\nb', 'a\rb', 'a\tb', 'bell\u0007', 'a b', 'a\u0085b']) {
        assert.ok(isError(ProfileNameSchema(name)), JSON.stringify(name))
    }
    // Markup is a valid name: it is escaped where it is shown.
    assert.equal(ProfileNameSchema('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>')
})

test('profile name: composed and decomposed é give the same value', () => {
    const composed = 'René'
    const decomposed = 'René'
    assert.notEqual(composed, decomposed)
    assert.equal(ProfileNameSchema(decomposed), composed)
    assert.equal(ProfileNameSchema(composed), composed)
})

test('update body: null resets a preference, an absent field stays absent', () => {
    assert.deepEqual(UpdateProfileInputSchema({ theme: null }), { theme: null })
    const partial = UpdateProfileInputSchema({ fontSize: 18 })
    assert.deepEqual(partial, { fontSize: 18 })
    assert.equal('theme' in partial, false)
    assert.deepEqual(
        UpdateProfileInputSchema({
            locale: null,
            timeZone: null,
            theme: null,
            colorTheme: null,
            fontSize: null,
        }),
        { locale: null, timeZone: null, theme: null, colorTheme: null, fontSize: null },
    )
    assert.deepEqual(UpdateProfileInputSchema({ name: ' Ann ', locale: 'uk' }), {
        name: 'Ann',
        locale: 'uk',
    })
})

test('update body: refused shapes', () => {
    const refused = [
        {},
        { name: null },
        { name: '' },
        { unknown: 1 },
        { theme: 'dark', extra: true },
        { locale: 'de' },
        { locale: 'en-US' },
        { fontSize: 13 },
        { fontSize: 21 },
        { fontSize: 16.5 },
        { fontSize: '16' },
        { colorTheme: 'red' },
        { theme: 'system' },
        { timeZone: '' },
        { timeZone: 'x'.repeat(65) },
    ]
    for (const body of refused) {
        assert.ok(isError(UpdateProfileInputSchema(body)), JSON.stringify(body))
    }
    // The schema bounds the zone only; whether it is a known IANA zone is the server's check.
    assert.deepEqual(UpdateProfileInputSchema({ timeZone: 'Mars/Base' }), { timeZone: 'Mars/Base' })
})

test('profile response: revision is a decimal string', () => {
    for (const revision of ['0', '42', '9007199254740993']) {
        assert.ok(!isError(ProfileSchema({ name: 'a', preferences: nullPreferences, revision })))
    }
    for (const revision of [42, '-1', '01', '', '1.5']) {
        assert.ok(
            isError(ProfileSchema({ name: 'a', preferences: nullPreferences, revision })),
            JSON.stringify(revision),
        )
    }
})

test('init response: a signed-in user carries preferences and revision', () => {
    const user = {
        id: '1',
        name: 'Ann',
        email: 'ann@example.com',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    }
    assert.ok(isError(InitResponseSchema({ status: 'ok', user })))
    assert.ok(
        !isError(
            InitResponseSchema({
                status: 'ok',
                user: { ...user, preferences: nullPreferences, revision: '0' },
            }),
        ),
    )
    assert.ok(!isError(InitResponseSchema({ status: 'ok' })))
})

test('isAllowedTimeZone: UTC and IANA zones only', () => {
    assert.equal(isAllowedTimeZone('UTC'), true)
    assert.equal(isAllowedTimeZone('Europe/Kyiv'), true)
    assert.equal(isAllowedTimeZone('America/New_York'), true)
    // ICU lists the older CLDR names; the current IANA aliases resolve to them.
    assert.equal(isAllowedTimeZone('Europe/Kiev'), true)
    assert.equal(isAllowedTimeZone('Etc/UTC'), true)
    assert.equal(isAllowedTimeZone('+02:00'), false)
    assert.equal(isAllowedTimeZone('Mars/Base'), false)
    assert.equal(isAllowedTimeZone(''), false)
    assert.equal(isAllowedTimeZone(null), false)
    const zones = allowedTimeZones()
    assert.equal(zones[0], 'UTC')
    assert.equal(zones.filter((zone) => zone === 'UTC').length, 1)
})
