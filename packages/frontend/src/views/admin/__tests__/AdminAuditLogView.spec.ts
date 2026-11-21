import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from '@/stores/user'
import type { AuditEvent } from 'shared/responses'

import en from '@/locales/en'

// feat-235 (Р10): the audit log page with the API replaced: the filters live in the URL, a row
// opens its changes, "Load more" appends the next page, a proof holder is shown without a user.

const api = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/utils/api', () => ({ adminAuditEventsApi: api }))
vi.mock('@/stores/state', () => ({ useStateStore: () => ({ timeZone: 'UTC' }) }))

const { default: AdminAuditLogView } = await import('../AdminAuditLogView.vue')

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const event = (id: string, over: Partial<AuditEvent> = {}): AuditEvent => ({
    id,
    occurredAt: '2026-11-20T10:00:00.123456Z',
    action: 'kb.article.updated',
    group: 'kb',
    actor: {
        kind: 'user',
        userId: '5',
        name: 'Ann Admin',
        deleted: false,
        role: 'admin',
        proof: null,
        source: null,
    },
    target: { type: 'kb_article', id: '9' },
    targetUser: null,
    requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    changes: {
        title: { from: 'Old', to: 'New' },
        content: {
            changed: true,
            sha256Before: 'a'.repeat(64),
            sha256After: 'b'.repeat(64),
            charsBefore: 10,
            charsAfter: 12,
        },
    },
    metadata: null,
    ...over,
})
const page = (items: AuditEvent[], nextCursor: string | null = null) => ({
    data: { status: 'success', items, nextCursor },
})

const mountAt = async (url: string) => {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/admin/audit-log', component: AdminAuditLogView }],
    })
    await router.push(url)
    await router.isReady()
    const wrapper = mount(AdminAuditLogView, { global: { plugins: [i18n, router] } })
    await flushPromises()
    return { wrapper, router }
}

describe('AdminAuditLogView', () => {
    beforeEach(() => {
        setActivePinia(createPinia())
        useUserStore().setUser({ id: '1', role: 'admin' })
        api.list.mockReset()
        api.list.mockResolvedValue(page([event('1')]))
    })

    it('reads the filters from the URL and writes them back on apply', async () => {
        const { wrapper, router } = await mountAt('/admin/audit-log?targetUserId=7&group=sessions')

        expect(api.list).toHaveBeenCalledWith({ group: 'sessions', targetUserId: '7' })
        expect((wrapper.find('input[name="targetUserId"]').element as HTMLInputElement).value).toBe(
            '7',
        )

        await wrapper.find('select[name="action"]').setValue(['auth.password.changed'])
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(router.currentRoute.value.query).toEqual({
            action: ['auth.password.changed'],
            group: 'sessions',
            targetUserId: '7',
        })
        expect(api.list).toHaveBeenLastCalledWith({
            action: ['auth.password.changed'],
            group: 'sessions',
            targetUserId: '7',
        })
    })

    it('a row opens its changes: fields as was / became, the text as hash and length', async () => {
        const { wrapper } = await mountAt('/admin/audit-log')
        expect(wrapper.find('[data-testid="audit-details"]').exists()).toBe(false)

        await wrapper.find('[data-testid="audit-row"]').trigger('click')

        const details = wrapper.find('[data-testid="audit-details"]').text()
        expect(details).toContain('title')
        expect(details).toContain('Old')
        expect(details).toContain('New')
        expect(details).toContain('aaaaaaaaaaaa…')
        expect(details).toContain('12 characters')
        expect(details).toContain('Copy request ID')
    })

    it('"Load more" asks for the next page and appends it', async () => {
        api.list.mockResolvedValueOnce(page([event('2')], 'cursor-1'))
        const { wrapper } = await mountAt('/admin/audit-log?targetType=kb_article&targetId=9')
        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(1)

        api.list.mockResolvedValueOnce(page([event('1')]))
        await wrapper.find('[data-testid="audit-load-more"]').trigger('click')
        await flushPromises()

        expect(api.list).toHaveBeenLastCalledWith({
            targetType: 'kb_article',
            targetId: '9',
            cursor: 'cursor-1',
        })
        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(2)
        expect(wrapper.find('[data-testid="audit-load-more"]').exists()).toBe(false)
    })

    it('shows a proof holder as "without sign-in" with its proof', async () => {
        api.list.mockResolvedValue(
            page([
                event('3', {
                    action: 'auth.password.reset',
                    group: 'sign-in',
                    actor: {
                        kind: 'proof_holder',
                        userId: null,
                        name: null,
                        deleted: false,
                        role: null,
                        proof: 'email_link',
                        source: null,
                    },
                    target: { type: 'user', id: '7' },
                    targetUser: { id: '7', name: 'Bob', deleted: false },
                    changes: null,
                    metadata: { proof: 'email_link', claimed: false },
                }),
            ]),
        )
        const { wrapper } = await mountAt('/admin/audit-log')

        expect(wrapper.find('[data-testid="audit-actor"]').text()).toBe(
            'without sign-in: link from an email',
        )
        expect(wrapper.text()).toContain('Password reset')
        expect(wrapper.text()).toContain('Account #7 (Bob)')
    })

    it('shows the empty and the error states', async () => {
        api.list.mockResolvedValueOnce(page([]))
        const empty = await mountAt('/admin/audit-log')
        expect(empty.wrapper.find('[data-testid="audit-empty"]').exists()).toBe(true)

        api.list.mockResolvedValueOnce({
            data: { status: 'error', code: 'internal_error', message: 'Database down' },
        })
        const failed = await mountAt('/admin/audit-log')
        expect(failed.wrapper.find('[data-testid="audit-error"]').text()).toContain('Database down')
    })

    // feat-235 review: every repeated `action` of the URL is kept, in the form, the request and
    // the request of the next page.
    it('keeps every action of the URL', async () => {
        api.list.mockResolvedValueOnce(page([event('2')], 'cursor-1'))
        const { wrapper, router } = await mountAt(
            '/admin/audit-log?action=auth.password.changed&action=auth.sessions.revoked_all',
        )
        const both = ['auth.password.changed', 'auth.sessions.revoked_all']

        expect(api.list).toHaveBeenLastCalledWith({ action: both })
        const selected = [
            ...(wrapper.find('select[name="action"]').element as HTMLSelectElement).selectedOptions,
        ].map((option) => option.value)
        expect(selected).toEqual(both)

        await wrapper.find('[data-testid="audit-load-more"]').trigger('click')
        await flushPromises()
        expect(api.list).toHaveBeenLastCalledWith({ action: both, cursor: 'cursor-1' })

        await wrapper.find('input[name="targetId"]').setValue('9')
        await wrapper.find('form').trigger('submit')
        await flushPromises()
        expect(router.currentRoute.value.query).toEqual({ action: both, targetId: '9' })
    })

    // feat-235 review: a "Load more" of the old filters that answers after the filters changed
    // must not append its events to the new list or replace its cursor.
    it('drops the answer of a page asked for before the filters changed', async () => {
        api.list.mockResolvedValueOnce(page([event('2')], 'old-cursor'))
        const { wrapper, router } = await mountAt('/admin/audit-log?group=kb')

        let answerOldPage: (value: unknown) => void = () => undefined
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                answerOldPage = resolve
            }),
        )
        await wrapper.find('[data-testid="audit-load-more"]').trigger('click')

        api.list.mockResolvedValueOnce(page([event('9', { action: 'auth.password.changed' })]))
        await router.replace({ query: { group: 'sign-in' } })
        await flushPromises()
        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(1)

        // The old page answers last.
        answerOldPage(page([event('1')], 'stale-cursor'))
        await flushPromises()

        const rows = wrapper.findAll('[data-testid="audit-row"]')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.text()).toContain('Password changed')
        expect(wrapper.find('[data-testid="audit-load-more"]').exists()).toBe(false)
    })

    // feat-240 (Р5, Р10): without audit.read the filters offer the account events only.
    it('offers a support_operator only the sign-in and session groups, actions and user targets', async () => {
        useUserStore().setUser({ id: '1', role: 'support_operator' })
        const { wrapper } = await mountAt('/admin/audit-log')

        const groups = wrapper
            .findAll('select[name="group"] option')
            .map((option) => option.attributes('value'))
        expect(groups).toEqual(['', 'sign-in', 'sessions'])
        const types = wrapper
            .findAll('select[name="targetType"] option')
            .map((option) => option.attributes('value'))
        expect(types).toEqual(['', 'user'])
        const actions = wrapper.findAll('option').map((option) => option.attributes('value'))
        expect(actions).not.toContain('kb.article.updated')
        expect(actions).not.toContain('user.role.changed')
        expect(actions).toContain('auth.password.changed')
    })

    // feat-242 (review 2026-11-21): losing audit.read drops the events of the full log at once and
    // reads the first page again with the filters the account scope allows.
    it('after losing audit.read drops the full log and reloads with the allowed filters', async () => {
        api.list.mockResolvedValueOnce(page([event('1')], 'cursor-1'))
        const { wrapper, router } = await mountAt(
            '/admin/audit-log?group=kb&targetType=kb_article&targetUserId=7',
        )
        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(1)

        let answer: (value: unknown) => void = () => undefined
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                answer = resolve
            }),
        )
        useUserStore().applyAccessChanged('support_operator')
        await flushPromises()

        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(0)
        expect(router.currentRoute.value.query).toEqual({ targetUserId: '7' })
        expect(api.list).toHaveBeenLastCalledWith({ targetUserId: '7' })

        answer(page([event('5', { action: 'auth.password.changed', group: 'sign-in' })]))
        await flushPromises()
        const rows = wrapper.findAll('[data-testid="audit-row"]')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.text()).toContain('Password changed')
    })

    it('drops a page of the full log that answers after audit.read was lost', async () => {
        api.list.mockResolvedValueOnce(page([event('2')], 'cursor-1'))
        const { wrapper } = await mountAt('/admin/audit-log?targetUserId=7')
        let answerOld: (value: unknown) => void = () => undefined
        api.list.mockReturnValueOnce(
            new Promise((resolve) => {
                answerOld = resolve
            }),
        )
        await wrapper.find('[data-testid="audit-load-more"]').trigger('click')
        api.list.mockResolvedValueOnce(page([]))
        useUserStore().applyAccessChanged('support_operator')
        await flushPromises()

        answerOld(page([event('1')]))
        await flushPromises()

        expect(wrapper.findAll('[data-testid="audit-row"]')).toHaveLength(0)
        expect(wrapper.find('[data-testid="audit-empty"]').exists()).toBe(true)
    })
})
