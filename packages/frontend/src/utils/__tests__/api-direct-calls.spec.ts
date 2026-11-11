import { describe, expect, it } from 'vitest'

// The text of the file, not the module (Vite's `?raw`).
import source from '../api.ts?raw'

// docs/adr/0005-route-contracts.md: until every route group has a contract, utils/api.ts keeps
// direct calls of the transport. ESLint forbids them everywhere else; this test keeps their
// number here from growing. A group that moves to `callApi` lowers the number; when it reaches
// zero, the file loses its exception in eslint.config.ts and this test goes (feat-170).
const DIRECT_HTTP_CALLS = 11
// Multipart is outside contracts (ADR 0005, decision 3): the avatar and the screenshot upload.
const UPLOAD_CALLS = 2

const count = (pattern: RegExp): number => source.match(pattern)?.length ?? 0

describe('direct transport calls left in utils/api.ts', () => {
    it('does not gain a call that bypasses the contracts', () => {
        expect(count(/\bbaseApi\.http\b/g)).toBeLessThanOrEqual(DIRECT_HTTP_CALLS)
    })

    it('says when the number can be lowered', () => {
        // Fails after a migration that forgot to lower the constant: the ratchet only turns one way.
        expect(count(/\bbaseApi\.http\b/g)).toBe(DIRECT_HTTP_CALLS)
    })

    it('keeps multipart uploads as the only other use of the transport', () => {
        expect(count(/\bbaseApi\.upload\b/g)).toBe(UPLOAD_CALLS)
    })
})
