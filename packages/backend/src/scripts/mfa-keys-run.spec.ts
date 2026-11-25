import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseMfaEncryptionKeys } from '../config/mfa.js'

import { readEnvKey } from './mfa-keys-env.js'
import { runMfaKeys } from './mfa-keys-run.js'

const KEY = 'MFA_ENCRYPTION_KEYS'
const b64 = (byte: number): string => Buffer.alloc(32, byte).toString('base64')
const APP_KEY = 'a'.repeat(32)

describe('mfa:keys run (feat-260)', () => {
    let dir: string
    let envPath: string
    const run = (args: string[], shell: Record<string, string | undefined> = {}) =>
        runMfaKeys({ args, shell, envPath })
    const fileValue = (): string => readEnvKey(readFileSync(envPath, 'utf8'), KEY)
    const ids = (value: string): string[] =>
        parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined }).keys.map(
            (key) => key.id,
        )

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mfa-keys-run-'))
        envPath = join(dir, '.env')
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('a first --write keeps the dev key the server derived from APP_KEY', () => {
        writeFileSync(envPath, `APP_KEY=${APP_KEY}\n${KEY}=\n`)
        const result = run(['--write'])
        expect(result.code).toBe(0)
        const value = fileValue()
        expect(ids(value)).toEqual(['k1', 'dev'])
        // The dev entry is the key the server used with the empty value.
        const derived = parseMfaEncryptionKeys('', { isProductionLike: false, appKey: APP_KEY })
        const written = parseMfaEncryptionKeys(value, { isProductionLike: true, appKey: undefined })
        expect(written.keys[1]?.key.equals(derived.keys[0]?.key ?? Buffer.alloc(0))).toBe(true)
    })

    it('a first --write without APP_KEY writes one key; the APP_KEY of the shell wins', () => {
        writeFileSync(envPath, `${KEY}=\n`)
        expect(run(['--write']).code).toBe(0)
        expect(ids(fileValue())).toEqual(['k1'])

        writeFileSync(envPath, `APP_KEY=${'b'.repeat(32)}\n`)
        expect(run(['--write'], { APP_KEY }).code).toBe(0)
        const derived = parseMfaEncryptionKeys('', { isProductionLike: false, appKey: APP_KEY })
        const written = parseMfaEncryptionKeys(fileValue(), {
            isProductionLike: true,
            appKey: undefined,
        })
        expect(written.keys[1]?.key.equals(derived.keys[0]?.key ?? Buffer.alloc(0))).toBe(true)
    })

    it.each([
        ['spaces around =', `${KEY} = k1:${b64(1)}\n`],
        ['export', `export ${KEY}=k1:${b64(1)}\n`],
        ['a comment', `${KEY}=k1:${b64(1)} # current\n`],
    ])('--write sees a current value written with %s and never replaces it', (_name, content) => {
        writeFileSync(envPath, content)
        const result = run(['--write'])
        expect(result.code).toBe(1)
        expect(result.err.join('\n')).toMatch(/already set/)
        expect(readFileSync(envPath, 'utf8')).toBe(content)
    })

    it('--rotate --write refuses a definition it cannot rewrite exactly; the file stays', () => {
        const content = `export ${KEY}=k1:${b64(1)}\n`
        writeFileSync(envPath, content)
        const result = run(['--rotate', '--write'])
        expect(result.code).toBe(1)
        expect(result.err.join('\n')).toMatch(/not a single plain/)
        expect(readFileSync(envPath, 'utf8')).toBe(content)
    })

    it('--rotate --write reads the last definition the server reads and keeps its keys', () => {
        writeFileSync(envPath, `${KEY}="k1:${b64(1)}"\nA=1\n`)
        expect(run(['--rotate', '--write']).code).toBe(0)
        expect(ids(fileValue())).toEqual(['k2', 'k1'])
        expect(fileValue().endsWith(`k1:${b64(1)}`)).toBe(true)
        expect(readFileSync(envPath, 'utf8')).toContain('\nA=1\n')
    })

    it('--write refuses while the shell sets the variable, even empty', () => {
        writeFileSync(envPath, `${KEY}=\n`)
        for (const shellValue of ['', `k1:${b64(1)}`]) {
            const result = run(['--write'], { [KEY]: shellValue })
            expect(result.code).toBe(1)
            expect(result.err.join('\n')).toMatch(/set in the shell/)
        }
        expect(readFileSync(envPath, 'utf8')).toBe(`${KEY}=\n`)
    })

    it('--check reads the shell first, an empty shell value included', () => {
        writeFileSync(envPath, `${KEY}=k1:${b64(1)}\n`)
        expect(run(['--check']).code).toBe(0)
        const empty = run(['--check'], { [KEY]: '' })
        expect(empty.code).toBe(1)
        expect(empty.err.join('\n')).toMatch(/of the shell: MFA_ENCRYPTION_KEYS is required/)
        expect(run(['--check'], { [KEY]: `k2:${b64(2)},k1:${b64(1)}` }).out).toContain(
            'Also read: k1.',
        )
    })

    it('--check prints ids only, never the key material', () => {
        writeFileSync(envPath, `${KEY}=k2:${b64(2)},k1:${b64(1)}\n`)
        const result = run(['--check'])
        expect(result.code).toBe(0)
        expect([...result.out, ...result.err].join('\n')).not.toContain(b64(1))
    })

    it('printing a new value warns about a current value and about the dev key', () => {
        writeFileSync(envPath, `APP_KEY=${APP_KEY}\n`)
        const fresh = run([])
        expect(fresh.code).toBe(0)
        expect(fresh.err.join('\n')).toMatch(/"dev" key derived from APP_KEY/)
        writeFileSync(envPath, `${KEY}=k1:${b64(1)}\n`)
        expect(run([]).err.join('\n')).toMatch(/replacing it makes every TOTP factor unreadable/)
    })

    it('refuses an unknown argument', () => {
        expect(run(['--force']).code).toBe(1)
    })
})
