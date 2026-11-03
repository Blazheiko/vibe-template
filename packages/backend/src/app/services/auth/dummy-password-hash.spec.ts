import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadModule() {
    return import('./dummy-password-hash.js')
}

afterEach(() => {
    vi.doUnmock('metautil')
    vi.resetModules()
})

// The scrypt parameters live in the hash: everything up to the salt.
function scryptParams(hash: string): string {
    return hash.split('$').slice(0, 3).join('$')
}

describe('getDummyPasswordHash', () => {
    it('is a scrypt hash with the same parameters as a real password hash', async () => {
        const { hashPassword } = await import('metautil')
        const { getDummyPasswordHash } = await loadModule()

        const dummy = await getDummyPasswordHash()
        const real = await hashPassword('secret123')

        expect(dummy.startsWith('$scrypt$')).toBe(true)
        expect(scryptParams(dummy)).toBe(scryptParams(real))
    })

    it('does not match an ordinary password', async () => {
        const { validatePassword } = await import('metautil')
        const { getDummyPasswordHash } = await loadModule()

        await expect(validatePassword('secret123', await getDummyPasswordHash())).resolves.toBe(
            false,
        )
    })

    it('is computed once and reused', async () => {
        const { getDummyPasswordHash } = await loadModule()

        const first = getDummyPasswordHash()
        const second = getDummyPasswordHash()

        expect(second).toBe(first)
        await expect(second).resolves.toBe(await first)
    })

    it('retries after a failed hash instead of keeping the failure', async () => {
        const hashPassword = vi
            .fn()
            .mockRejectedValueOnce(new Error('scrypt failed'))
            .mockResolvedValueOnce('dummy-hash')
        vi.doMock('metautil', () => ({ hashPassword }))
        const { getDummyPasswordHash } = await loadModule()

        await expect(getDummyPasswordHash()).rejects.toThrow('scrypt failed')
        await expect(getDummyPasswordHash()).resolves.toBe('dummy-hash')
        expect(hashPassword).toHaveBeenCalledTimes(2)
    })
})
