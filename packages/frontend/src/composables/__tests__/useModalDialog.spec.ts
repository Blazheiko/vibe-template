import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { useModalDialog } from '../useModalDialog'

// feat-164 (review 2026-11-10): the modals had no keyboard behaviour: focus stayed on the page
// behind them, Tab walked out of them, Escape did nothing.

const Dialog = defineComponent({
    props: {
        open: { type: Boolean, required: true },
        name: { type: String, default: 'a' },
        empty: { type: Boolean, default: false },
        initial: { type: Boolean, default: false },
    },
    emits: ['close'],
    setup(props, { emit }) {
        const panel = ref<HTMLElement | null>(null)
        useModalDialog({
            panel,
            isOpen: () => props.open,
            close: () => {
                emit('close')
            },
        })
        return () =>
            props.open
                ? h(
                      'div',
                      { ref: panel, role: 'dialog', tabindex: '-1', id: `panel-${props.name}` },
                      props.empty
                          ? [h('p', 'Nothing to focus')]
                          : [
                                h('button', { id: `close-${props.name}`, 'data-modal-close': '' }),
                                h('input', { id: `first-${props.name}` }),
                                h('input', { id: `disabled-${props.name}`, disabled: true }),
                                h('button', {
                                    id: `last-${props.name}`,
                                    ...(props.initial ? { 'data-modal-initial-focus': '' } : {}),
                                }),
                            ],
                  )
                : null
    },
})

const Page = defineComponent({
    props: { second: { type: Boolean, default: false }, empty: Boolean, initial: Boolean },
    setup(props) {
        const open = ref(false)
        const openSecond = ref(false)
        return () => [
            h('button', {
                id: 'opener',
                onClick: () => {
                    open.value = true
                },
            }),
            h(Dialog, {
                open: open.value,
                empty: props.empty,
                initial: props.initial,
                onClose: () => {
                    open.value = false
                },
            }),
            h('button', {
                id: 'swap',
                onClick: () => {
                    open.value = false
                    openSecond.value = true
                },
            }),
            h('button', {
                id: 'stack',
                onClick: () => {
                    openSecond.value = true
                },
            }),
            props.second
                ? h(Dialog, {
                      open: openSecond.value,
                      name: 'b',
                      onClose: () => {
                          openSecond.value = false
                      },
                  })
                : null,
        ]
    },
})

const mounted: { unmount: () => void }[] = []
const mountPage = (props: Record<string, boolean> = {}) => {
    const wrapper = mount(Page, { props, attachTo: document.body })
    mounted.push(wrapper)
    return wrapper
}

const open = async (wrapper: ReturnType<typeof mountPage>) => {
    const opener = wrapper.find<HTMLButtonElement>('#opener')
    opener.element.focus()
    await opener.trigger('click')
    await flushPromises()
}

const press = async (key: string, shiftKey = false): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    ;(document.activeElement ?? document.body).dispatchEvent(event)
    await flushPromises()
    return event
}

const focusedId = (): string | undefined => document.activeElement?.id

describe('useModalDialog', () => {
    afterEach(() => {
        while (mounted.length > 0) mounted.pop()?.unmount()
    })

    it('moves focus into the dialog: the first control that is not the close button', async () => {
        const wrapper = mountPage()

        await open(wrapper)

        expect(focusedId()).toBe('first-a')
    })

    it('prefers the element marked as the initial focus', async () => {
        const wrapper = mountPage({ initial: true })

        await open(wrapper)

        expect(focusedId()).toBe('last-a')
    })

    it('focuses the panel when nothing in it can take focus, and keeps Tab there', async () => {
        const wrapper = mountPage({ empty: true })

        await open(wrapper)
        expect(focusedId()).toBe('panel-a')

        const event = await press('Tab')
        expect(event.defaultPrevented).toBe(true)
        expect(focusedId()).toBe('panel-a')
    })

    it('keeps Tab inside: from the last control to the first and back', async () => {
        const wrapper = mountPage()
        await open(wrapper)

        wrapper.find<HTMLButtonElement>('#last-a').element.focus()
        const forward = await press('Tab')
        expect(forward.defaultPrevented).toBe(true)
        expect(focusedId()).toBe('close-a')

        const back = await press('Tab', true)
        expect(back.defaultPrevented).toBe(true)
        expect(focusedId()).toBe('last-a')
    })

    it('leaves Tab between two controls of the dialog to the browser', async () => {
        const wrapper = mountPage()
        await open(wrapper)

        const event = await press('Tab')

        expect(event.defaultPrevented).toBe(false)
    })

    it('brings focus back from the page behind on Tab', async () => {
        const wrapper = mountPage()
        await open(wrapper)
        wrapper.find<HTMLButtonElement>('#swap').element.focus()

        await press('Tab')

        expect(focusedId()).toBe('close-a')
    })

    it('closes on Escape and returns focus to the button that opened it', async () => {
        const wrapper = mountPage()
        await open(wrapper)

        const event = await press('Escape')

        expect(event.defaultPrevented).toBe(true)
        expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
        expect(focusedId()).toBe('opener')
    })

    it('does not listen to the keyboard once closed', async () => {
        const wrapper = mountPage()
        await open(wrapper)
        await press('Escape')

        const event = await press('Escape')

        expect(event.defaultPrevented).toBe(false)
    })

    it('one dialog replacing another: the second returns focus to the page opener', async () => {
        const wrapper = mountPage({ second: true })
        await open(wrapper)

        await wrapper.find('#swap').trigger('click')
        await flushPromises()
        expect(wrapper.find('#panel-a').exists()).toBe(false)
        expect(focusedId()).toBe('first-b')

        await press('Escape')
        expect(wrapper.find('#panel-b').exists()).toBe(false)
        expect(focusedId()).toBe('opener')
    })

    it('a dialog over a dialog: Escape closes the top one and focus returns under it', async () => {
        const wrapper = mountPage({ second: true })
        await open(wrapper)
        wrapper.find<HTMLButtonElement>('#last-a').element.focus()

        await wrapper.find('#stack').trigger('click')
        await flushPromises()
        expect(focusedId()).toBe('first-b')

        await press('Escape')
        expect(wrapper.find('#panel-b').exists()).toBe(false)
        expect(wrapper.find('#panel-a').exists()).toBe(true)
        expect(focusedId()).toBe('last-a')

        await press('Escape')
        expect(wrapper.find('#panel-a').exists()).toBe(false)
        expect(focusedId()).toBe('opener')
    })

    it('returns focus when the dialog is unmounted while open', async () => {
        const wrapper = mountPage()
        await open(wrapper)
        const opener = wrapper.find<HTMLButtonElement>('#opener').element
        const Host = defineComponent({
            setup() {
                const shown = ref(true)
                return () => [
                    h('button', {
                        id: 'hide',
                        onClick: () => {
                            shown.value = false
                        },
                    }),
                    shown.value ? h(Dialog, { open: true, name: 'c' }) : null,
                ]
            },
        })
        const host = mount(Host, { attachTo: document.body })
        mounted.push(host)
        await flushPromises()
        expect(focusedId()).toBe('first-c')

        await host.find('#hide').trigger('click')
        await flushPromises()

        expect(document.activeElement).toBe(wrapper.find('#first-a').element)
        expect(opener.isConnected).toBe(true)
    })
})
