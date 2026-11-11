import { nextTick, onBeforeUnmount, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * The keyboard behaviour of a modal dialog: focus moves into the panel when it opens, Tab stays
 * inside it, Escape closes it, and focus goes back to where it was when the dialog closes.
 * The panel element carries `role="dialog"`, `aria-modal="true"`, a label and `tabindex="-1"`
 * in the template of the component that uses this.
 *
 * Initial focus: the element marked `data-modal-initial-focus`, else the first focusable one
 * that is not marked `data-modal-close`, else the panel itself. Focus that is already inside
 * the panel (a form that focuses its own field) is left alone.
 */
export interface ModalDialogOptions {
    panel: Ref<HTMLElement | null>
    isOpen: () => boolean
    close: () => void
}

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

// The open dialogs, the topmost last: only that one answers the keyboard.
const openDialogs: symbol[] = []
// What had focus on the page before the first dialog opened. One dialog replacing another
// (sign-in -> registration) keeps it: the element that opened the second one is inside the
// first and is hidden by the time the second closes.
let pageFocus: HTMLElement | null = null

const focusedElement = (): HTMLElement | null =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null

export function useModalDialog({ panel, isOpen, close }: ModalDialogOptions): void {
    const id = Symbol('modal-dialog')
    let returnTo: HTMLElement | null = null

    const focusables = (): HTMLElement[] =>
        panel.value === null ? [] : Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE))

    const onKeydown = (event: KeyboardEvent): void => {
        if (openDialogs[openDialogs.length - 1] !== id) return
        if (event.key === 'Escape') {
            event.preventDefault()
            close()
            return
        }
        if (event.key !== 'Tab' || panel.value === null) return

        const items = focusables()
        if (items.length === 0) {
            event.preventDefault()
            panel.value.focus()
            return
        }
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        const inside = active !== null && panel.value.contains(active)
        if (event.shiftKey) {
            if (!inside || active === first || active === panel.value) {
                event.preventDefault()
                last.focus()
            }
        } else if (!inside || active === last) {
            event.preventDefault()
            first.focus()
        }
    }

    const opened = async (): Promise<void> => {
        returnTo = focusedElement()
        if (openDialogs.length === 0 && pageFocus === null) pageFocus = returnTo
        openDialogs.push(id)
        document.addEventListener('keydown', onKeydown)

        await nextTick()
        if (!openDialogs.includes(id) || panel.value === null) return
        if (panel.value.contains(document.activeElement)) return
        const target =
            panel.value.querySelector<HTMLElement>('[data-modal-initial-focus]') ??
            focusables().find((element) => !element.hasAttribute('data-modal-close')) ??
            panel.value
        target.focus()
    }

    const closed = (): void => {
        const index = openDialogs.indexOf(id)
        if (index === -1) return
        openDialogs.splice(index, 1)
        document.removeEventListener('keydown', onKeydown)

        const own = returnTo
        returnTo = null
        if (openDialogs.length > 0) {
            // A dialog under this one is still open: back to the element in it.
            if (own?.isConnected === true) own.focus()
            return
        }
        // Wait a tick: another dialog may be opening in place of this one.
        void nextTick(() => {
            if (openDialogs.length > 0) return
            const target = pageFocus
            pageFocus = null
            if (target?.isConnected === true) target.focus()
        })
    }

    watch(
        isOpen,
        (open) => {
            if (open) void opened()
            else closed()
        },
        { immediate: true },
    )
    onBeforeUnmount(closed)
}
