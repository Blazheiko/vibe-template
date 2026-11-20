// feat-236 (Р7): a link with a fragment (`/account#sessions`) opens the page at that section. The
// section may appear only after the page has loaded its data, so it is waited for, briefly.
// Called after each navigation (router/index.ts); without a fragment nothing scrolls.

export const SCROLL_TO_HASH_WAIT_MS = 3000
const POLL_MS = 50

const find = (root: Pick<Document, 'querySelector'>, hash: string): Element | null => {
    try {
        return root.querySelector(hash)
    } catch {
        // Not a selector (`#1abc`): there is no such section to scroll to.
        return null
    }
}

/** Scrolls to the element of `hash` once it exists; resolves whether it did. */
export function scrollToHash(
    hash: string,
    options: { waitMs?: number; root?: Pick<Document, 'querySelector'> } = {},
): Promise<boolean> {
    if (hash === '' || hash === '#') return Promise.resolve(false)
    const root = options.root ?? document
    const waitMs = options.waitMs ?? SCROLL_TO_HASH_WAIT_MS
    return new Promise((resolve) => {
        const started = Date.now()
        const poll = (): void => {
            const element = find(root, hash)
            if (element !== null) {
                element.scrollIntoView({ block: 'start' })
                resolve(true)
                return
            }
            if (Date.now() - started >= waitMs) {
                resolve(false)
                return
            }
            setTimeout(poll, POLL_MS)
        }
        poll()
    })
}
