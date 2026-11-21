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
})
