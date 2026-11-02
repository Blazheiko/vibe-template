import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    APP_LOCALE_CODES,
    formatLanguageLabel,
    isAppLocaleCode,
    resolveLanguageCode,
    resolveLanguageName,
    resolveLanguageNativeName,
} from '../dist/enums/index.js'

test('resolveLanguageCode maps browser locales to an app locale, else en', () => {
    assert.equal(resolveLanguageCode('uk-UA'), 'uk')
    assert.equal(resolveLanguageCode('zh_CN'), 'zh')
    assert.equal(resolveLanguageCode('pt-BR,pt;q=0.9,en;q=0.8'), 'pt')
    assert.equal(resolveLanguageCode('EN-us'), 'en')
    assert.equal(resolveLanguageCode('ga-IE'), 'en')
    assert.equal(resolveLanguageCode(''), 'en')
})

test('isAppLocaleCode accepts exactly the declared locales', () => {
    for (const code of APP_LOCALE_CODES) {
        assert.equal(isAppLocaleCode(code), true, code)
    }
    assert.equal(isAppLocaleCode(' DE '), true)
    assert.equal(isAppLocaleCode('klingon'), false)
    assert.equal(isAppLocaleCode('pt-BR'), false)
})

test('every app locale has an English and a native name', () => {
    for (const code of APP_LOCALE_CODES) {
        assert.notEqual(resolveLanguageName(code), code, `${code} has no English name`)
        assert.ok(resolveLanguageNativeName(code).length > 0, code)
    }
})

test('language names fall back to the raw code and ignore the region', () => {
    assert.equal(resolveLanguageName('uk-UA'), 'Ukrainian')
    assert.equal(resolveLanguageName('xx'), 'xx')
    assert.equal(formatLanguageLabel('uk'), `Ukrainian (${resolveLanguageNativeName('uk')})`)
})

test('the shipped interface languages are a subset of the recognised ones, English first', async () => {
    const { SHIPPED_LOCALE_CODES, isShippedLocale } = await import('../dist/enums/index.js')
    assert.deepEqual([...SHIPPED_LOCALE_CODES], ['en', 'uk', 'pl'])
    for (const code of SHIPPED_LOCALE_CODES) {
        assert.equal(isAppLocaleCode(code), true, code)
        assert.equal(isShippedLocale(code), true, code)
    }
    // recognised, but no interface translation
    assert.equal(isAppLocaleCode('ru'), true)
    assert.equal(isShippedLocale('ru'), false)
    assert.equal(isShippedLocale('UK'), false)
    assert.equal(isShippedLocale(''), false)
})
