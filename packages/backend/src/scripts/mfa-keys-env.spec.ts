import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    chmodSync,
    readdirSync,
    lstatSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readEnvKey, setEnvKey, updateFileAtomically } from './mfa-keys-env.js'

const KEY = 'MFA_ENCRYPTION_KEYS'

describe('mfa:keys .env reading (feat-260)', () => {
    it('reads what the server reads: export, spaces, a comment, the last definition', () => {
        expect(readEnvKey(`${KEY}=a\n`, KEY)).toBe('a')
        expect(readEnvKey(`${KEY} = a\n`, KEY)).toBe('a')
        expect(readEnvKey(`export ${KEY}=a\n`, KEY)).toBe('a')
        expect(readEnvKey(`${KEY}=a # old\n`, KEY)).toBe('a')
        expect(readEnvKey(`${KEY}=a\n${KEY}="b"\n`, KEY)).toBe('b')
        expect(readEnvKey('OTHER=x\n', KEY)).toBe('')
    })
})

describe('mfa:keys .env writing (feat-260)', () => {
    it('replaces one plain line in place and keeps the rest', () => {
        const result = setEnvKey(`A=1\n${KEY}=\nB=2\n`, KEY, 'k1:x')
        expect(result).toEqual({ ok: true, content: `A=1\n${KEY}="k1:x"\nB=2\n` })
        expect(setEnvKey(`${KEY}="k1:old"\n`, KEY, 'k2:y,k1:old')).toEqual({
            ok: true,
            content: `${KEY}="k2:y,k1:old"\n`,
        })
    })

    it('appends a missing key', () => {
        expect(setEnvKey('A=1', KEY, 'k1:x')).toEqual({ ok: true, content: `A=1\n${KEY}="k1:x"\n` })
        expect(setEnvKey('', KEY, 'k1:x')).toEqual({ ok: true, content: `${KEY}="k1:x"\n` })
    })

    it.each([
        ['spaces around =', `${KEY} = k1:old\n`],
        ['export', `export ${KEY}=k1:old\n`],
        ['a comment', `${KEY}=k1:old # keep\n`],
        ['two definitions', `${KEY}=k1:old\n${KEY}=k1:other\n`],
        ['a colon form', `${KEY}: k1:old\n`],
        ['a single-quoted value', `${KEY}='k1:old'\n`],
    ])('refuses a definition it cannot rewrite exactly: %s', (_name, content) => {
        const result = setEnvKey(content, KEY, 'k1:new')
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toMatch(/not a single plain/)
    })
})

describe('mfa:keys atomic update (feat-260)', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mfa-keys-'))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('replaces the file, keeps its mode and leaves no lock or temporary file', () => {
        const path = join(dir, '.env')
        writeFileSync(path, 'A=1\n')
        chmodSync(path, 0o640)
        const result = updateFileAtomically(path, (content) => ({
            content: `${content}B=2\n`,
            result: 'done',
        }))
        expect(result).toBe('done')
        expect(readFileSync(path, 'utf8')).toBe('A=1\nB=2\n')
        expect(statSync(path).mode & 0o777).toBe(0o640)
        expect(readdirSync(dir)).toEqual(['.env'])
    })

    it('creates a missing file with mode 600', () => {
        const path = join(dir, '.env')
        updateFileAtomically(path, () => ({ content: 'A=1\n', result: null }))
        expect(readFileSync(path, 'utf8')).toBe('A=1\n')
        expect(statSync(path).mode & 0o777).toBe(0o600)
    })

    it('leaves the file as it is when the update writes nothing or throws', () => {
        const path = join(dir, '.env')
        writeFileSync(path, 'A=1\n')
        updateFileAtomically(path, () => ({ content: null, result: null }))
        expect(() =>
            updateFileAtomically(path, () => {
                throw new Error('boom')
            }),
        ).toThrow('boom')
        expect(readFileSync(path, 'utf8')).toBe('A=1\n')
        expect(readdirSync(dir)).toEqual(['.env'])
    })

    it('refuses while another run holds the lock, and reads under the lock', () => {
        const path = join(dir, '.env')
        writeFileSync(path, 'A=1\n')
        writeFileSync(`${path}.lock`, '')
        expect(() => updateFileAtomically(path, () => ({ content: 'X\n', result: null }))).toThrow(
            /another run is writing/,
        )
        expect(readFileSync(path, 'utf8')).toBe('A=1\n')
        rmSync(`${path}.lock`)
        // A nested run inside an update is the other run: refused.
        updateFileAtomically(path, () => {
            expect(() =>
                updateFileAtomically(path, () => ({ content: 'Y\n', result: null })),
            ).toThrow(/another run is writing/)
            return { content: 'B=2\n', result: null }
        })
        expect(readFileSync(path, 'utf8')).toBe('B=2\n')
    })

    it('follows a symlink and replaces its target', () => {
        const target = join(dir, 'real.env')
        const link = join(dir, '.env')
        writeFileSync(target, 'A=1\n')
        symlinkSync(target, link)
        updateFileAtomically(link, () => ({ content: 'B=2\n', result: null }))
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(readFileSync(target, 'utf8')).toBe('B=2\n')
    })
})
