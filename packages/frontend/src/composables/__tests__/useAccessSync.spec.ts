import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from 'shared/access'

import { useUserStore } from '@/stores/user'

vi.mock('@/utils/api', () => ({ accountApi: { getAccess: vi.fn() } }))

const { createAccessSync } = await import('../useAccessSync')

// feat-240 (Р8, Р10): the role of the tab from two sources; an older answer never wins.

const deferred = () => {
    let resolve: (role: Role | null) => void = () => undefined
    const promise = new Promise<Role | null>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

describe('access sync', () => {
    let path = { path: '/account', permission: undefined, staff: false } as {
        path: string
        permission: Parameters<typeof import('@/views/admin/admin-pages').adminRedirect>[1]
        staff: boolean
    }
    const replace = vi.fn()

    beforeEach(() => {
        setActivePinia(createPinia())
        useUserStore().setUser({ id: '1', role: 'admin' })
        replace.mockReset()
        path = { path: '/account', permission: undefined, staff: false }
    })

    const make = (fetchRole: () => Promise<Role | null>) =>
        createAccessSync({ fetchRole, currentPath: () => path, replace })

    it('applies the role a read answered', async () => {
        await make(() => Promise.resolve('kb_editor')).readAgain()
        expect(useUserStore().user?.role).toBe('kb_editor')
    })

    it('drops an answer that started before an access_changed', async () => {
        const store = useUserStore()
        const answer = deferred()
        const reading = make(() => answer.promise).readAgain()

        store.applyAccessChanged('user')
        answer.resolve('admin')
        await reading

        expect(store.user?.role).toBe('user')
    })

    it('drops an answer that started before the account changed', async () => {
        const store = useUserStore()
        const answer = deferred()
        const reading = make(() => answer.promise).readAgain()

        store.setUser({ id: '2', role: 'user' })
        answer.resolve('admin')
        await reading

        expect(store.user).toMatchObject({ id: '2', role: 'user' })
    })

    it('drops an answer older than the last read started', async () => {
        const store = useUserStore()
        const older = deferred()
        const newer = deferred()
        const answers = [older, newer]
        const sync = make(() => (answers.shift() ?? newer).promise)
        const first = sync.readAgain()
        const second = sync.readAgain()

        newer.resolve('support_operator')
        await second
        older.resolve('admin')
        await first

        expect(store.user?.role).toBe('support_operator')
    })

    it('leaves an admin page the new role may not see', () => {
        const store = useUserStore()
        path = { path: '/admin/history-online', permission: 'users.sensitive.read', staff: true }
        store.applyAccessChanged('support_operator')
        make(() => Promise.resolve(null)).recheckRoute()
        expect(replace).toHaveBeenCalledWith('/admin/knowledge-base')

        replace.mockReset()
        store.applyAccessChanged('user')
        make(() => Promise.resolve(null)).recheckRoute()
        expect(replace).toHaveBeenCalledWith('/account')
    })

    it('stays on a page outside the admin area', () => {
        useUserStore().applyAccessChanged('user')
        make(() => Promise.resolve(null)).recheckRoute()
        expect(replace).not.toHaveBeenCalled()
    })

    // feat-247 (Р11): the admin channel taken away for the staff MFA rule.
    it('an expired staff session leaves an open admin page for the sign-in, back there after', () => {
        path = { path: '/admin/users', permission: 'users.read', staff: true }
        const signInAgain = vi.fn()
        make(() => Promise.resolve(null)).staffSessionExpired(signInAgain)
        expect(signInAgain).toHaveBeenCalledWith('/admin/users')
    })

    it('outside the admin area an expired staff session changes nothing', () => {
        const signInAgain = vi.fn()
        make(() => Promise.resolve(null)).staffSessionExpired(signInAgain)
        expect(signInAgain).not.toHaveBeenCalled()
    })

    // feat-247 (Р10): a request of the admin area refused for the staff MFA rule.
    it('a staff MFA refusal leaves the admin page for the security section, until a new sign-in', () => {
        const store = useUserStore()
        path = { path: '/admin/users', permission: 'users.read', staff: true }
        make(() => Promise.resolve(null)).staffMfaRefused('mfa_session_required')

        expect(store.staffMfaRefusal).toBe('mfa_session_required')
        expect(replace).toHaveBeenCalledWith(
            '/account?section=security&reason=mfa_session_required',
        )

        // A new sign-in sets the user again: the admin area is tried again.
        store.setUser({ id: '1', role: 'admin' })
        expect(store.staffMfaRefusal).toBeNull()
    })

    it('a staff MFA refusal outside the admin area only remembers it', () => {
        const store = useUserStore()
        make(() => Promise.resolve(null)).staffMfaRefused('mfa_required')
        expect(store.staffMfaRefusal).toBe('mfa_required')
        expect(replace).not.toHaveBeenCalled()

        store.clearUser()
        expect(store.staffMfaRefusal).toBeNull()
    })
})
