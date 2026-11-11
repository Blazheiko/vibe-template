import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-162 (review 2026-11-10): a failed list request came back as an empty list, so the view
// said "No articles yet" and offered to initialise a knowledge base that was already there;
// a failed delete, reindex or screenshot action changed nothing and said nothing.

const api = vi.hoisted(() => ({
    getAll: vi.fn(),
    getInitStatus: vi.fn(),
    delete: vi.fn(),
    reindex: vi.fn(),
    reindexAll: vi.fn(),
    deleteScreenshot: vi.fn(),
    uploadScreenshot: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    startInit: vi.fn(),
}))
vi.mock('@/utils/api', () => ({ adminKnowledgeBaseApi: api }))

const article = {
    id: '7',
    title: 'Billing',
    content: 'text',
    category: null,
    isActive: true,
    embeddingIndexed: true,
    hasScreenshot: true,
}

const mountView = async () => {
    const { default: View } = await import('../AdminKnowledgeBaseView.vue')
    const wrapper = mount(View)
    await flushPromises()
    return wrapper
}

const button = (wrapper: Awaited<ReturnType<typeof mountView>>, label: string) => {
    const found = wrapper.findAll('button').find((item) => item.text() === label)
    if (found === undefined) throw new Error(`no button "${label}"`)
    return found
}

describe('AdminKnowledgeBaseView', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        api.getInitStatus.mockResolvedValue(null)
        api.getAll.mockResolvedValue({ items: [article], total: 1 })
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        )
    })

    it('shows the error of a failed list and does not offer to initialise', async () => {
        api.getAll.mockRejectedValue(new Error('Internal server error'))

        const wrapper = await mountView()

        expect(wrapper.find('[role="alert"]').text()).toBe('Internal server error')
        expect(wrapper.text()).not.toContain('No articles yet')
        expect(wrapper.findAll('button').map((item) => item.text())).not.toContain('Init')
    })

    it('offers to initialise an empty knowledge base', async () => {
        api.getAll.mockResolvedValue({ items: [], total: 0 })

        const wrapper = await mountView()

        expect(wrapper.text()).toContain('No articles yet')
        expect(wrapper.findAll('button').map((item) => item.text())).toContain('Init')
    })

    it.each([
        ['Delete', 'delete', false, 'Failed to delete "Billing"'],
        ['Reindex', 'reindex', false, 'Failed to reindex "Billing"'],
        [
            'Del Screenshot',
            'deleteScreenshot',
            null,
            'Failed to delete the screenshot of "Billing"',
        ],
    ] as const)('says that "%s" failed', async (label, method, failure, message) => {
        api[method].mockResolvedValue(failure)
        const wrapper = await mountView()

        await button(wrapper, label).trigger('click')
        await flushPromises()

        expect(wrapper.find('[role="alert"]').text()).toBe(message)
    })

    it('clears the message of a failed action when the next one succeeds', async () => {
        api.reindex.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const wrapper = await mountView()

        await button(wrapper, 'Reindex').trigger('click')
        await flushPromises()
        expect(wrapper.find('[role="alert"]').exists()).toBe(true)

        await button(wrapper, 'Reindex').trigger('click')
        await flushPromises()
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })

    it('reports a failed reindex of everything and the articles it could not embed', async () => {
        api.reindexAll.mockResolvedValueOnce(null)
        const wrapper = await mountView()

        await button(wrapper, 'Reindex All').trigger('click')
        await flushPromises()
        expect(wrapper.find('[role="alert"]').text()).toBe('Failed to reindex the knowledge base')

        api.reindexAll.mockResolvedValueOnce({ indexed: 3, failed: ['4', '9'] })
        await button(wrapper, 'Reindex All').trigger('click')
        await flushPromises()
        expect(wrapper.text()).toContain('Indexed 3 article(s), 2 failed (ids: 4, 9)')
    })

    it('says that the screenshot of a saved article was not uploaded', async () => {
        api.update.mockResolvedValue(article)
        api.uploadScreenshot.mockResolvedValue(null)
        const wrapper = await mountView()
        await button(wrapper, 'Edit').trigger('click')
        const input = wrapper.find('input[type="file"]')
        Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'shot.png')] })
        await input.trigger('change')

        await button(wrapper, 'Save').trigger('click')
        await flushPromises()

        expect(wrapper.find('[role="alert"]').text()).toBe(
            'The article was saved, but its screenshot was not uploaded',
        )
    })
})
