import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
        api.list.mockReset()
        api.list.mockResolvedValue(page([event('1')]))
    })

    it('reads the filters from the URL and writes them back on apply', async () => {
        const { wrapper, router } = await mountAt('/admin/audit-log?targetUserId=7&group=sessions')

        expect(api.list).toHaveBeenCalledWith({ group: 'sessions', targetUserId: '7' })
        expect((wrapper.find('input[name="targetUserId"]').element as HTMLInputElement).value).toBe(
            '7',
        )

        await wrapper.find('select[name="action"]').setValue('auth.password.changed')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(router.currentRoute.value.query).toEqual({
            action: 'auth.password.changed',
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
})
