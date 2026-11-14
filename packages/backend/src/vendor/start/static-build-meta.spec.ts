import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUILD_META_FILE, checkStaticBuildPrefix } from './static-build-meta.js'

// feat-153: the SPA's API prefix is compiled in, the server's is read at run time.
describe('checkStaticBuildPrefix', () => {
    let directory = ''

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'static-build-meta-'))
    })

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true })
    })

    const writeMeta = (content: string): Promise<void> =>
        fs.writeFile(path.join(directory, BUILD_META_FILE), content)

    it('matches when the SPA was built for the prefix the server serves', async () => {
        await writeMeta(JSON.stringify({ apiPathPrefix: 'v1' }))
        expect(await checkStaticBuildPrefix(directory, 'v1')).toEqual({
            kind: 'match',
            prefix: 'v1',
        })
    })

    it('reports a SPA built for another prefix', async () => {
        await writeMeta(JSON.stringify({ apiPathPrefix: 'api' }))
        expect(await checkStaticBuildPrefix(directory, 'v1')).toEqual({
            kind: 'mismatch',
            builtFor: 'api',
            served: 'v1',
        })
    })

    it.each([
        ['no file', null],
        ['not JSON', '<html>'],
        ['no prefix in it', '{}'],
        ['an empty prefix', '{"apiPathPrefix":""}'],
        ['a prefix that is not a string', '{"apiPathPrefix":7}'],
        ['JSON null', 'null'],
    ])('does not judge static files it knows nothing about: %s', async (_name, content) => {
        if (content !== null) await writeMeta(content)
        expect(await checkStaticBuildPrefix(directory, 'api')).toEqual({ kind: 'unknown' })
    })
})
