// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pinApiPrefix, readDevBackend } from '../../vite.backend'

// feat-192: the dev proxy and the compiled prefix come from packages/backend/.env.
let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vite-backend-'))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('readDevBackend', () => {
    it('reads PORT and API_PATH_PREFIX from the backend .env file', () => {
        const file = join(dir, '.env')
        writeFileSync(file, 'PORT=4100\nHOST=0.0.0.0\nAPI_PATH_PREFIX="v1"\n')
        expect(readDevBackend(file, {})).toEqual({
            origin: 'http://127.0.0.1:4100',
            port: 4100,
            prefix: 'v1',
        })
    })

    it('lets the shell win and works without the file', () => {
        expect(readDevBackend(join(dir, 'missing.env'), { PORT: '5000' }).origin).toBe(
            'http://127.0.0.1:5000',
        )
    })
})

describe('pinApiPrefix', () => {
    it('hands the backend prefix to the bundle', () => {
        const shell: NodeJS.ProcessEnv = {}
        pinApiPrefix('v1', dir, shell)
        expect(shell.VITE_API_PATH_PREFIX).toBe('v1')
    })

    it('fails on a different VITE_API_PATH_PREFIX in a frontend .env file', () => {
        writeFileSync(join(dir, '.env'), 'VITE_API_PATH_PREFIX=api\n')
        expect(() => {
            pinApiPrefix('v1', dir, {})
        }).toThrow(/differs from the backend/)
    })

    it('fails on a different VITE_API_PATH_PREFIX in the shell', () => {
        expect(() => {
            pinApiPrefix('v1', dir, { VITE_API_PATH_PREFIX: 'v2' })
        }).toThrow(/differs from the backend/)
    })
})
