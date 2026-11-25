import type * as fs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { updateFileAtomically } from './mfa-keys-env.js'

// feat-260: a write that fails (a full disk) must not leave the temporary file with the secret.
vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof fs>()
    return {
        ...original,
        writeSync: () => {
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
        },
    }
})

describe('mfa:keys atomic update, failed write (feat-260)', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mfa-keys-enospc-'))
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('removes the temporary file and keeps the old content and no lock', () => {
        const path = join(dir, '.env')
        writeFileSync(path, 'A=1\n')
        expect(() =>
            updateFileAtomically(path, () => ({ content: 'SECRET=1\n', result: null })),
        ).toThrow(/no space left/)
        expect(readdirSync(dir)).toEqual(['.env'])
        expect(readFileSync(path, 'utf8')).toBe('A=1\n')
    })
})
