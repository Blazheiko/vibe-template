import { nextTick } from 'vue'

/** The pane the test form lives in scrolls, not the page; it is `main` where there is no such pane. */
function findScrollContainer(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>('.test-workspace-scroll') ??
        document.querySelector<HTMLElement>('main')
    )
}

/**
 * Brings the response into view once it has rendered: the element with `bodyId`, else the one with
 * `sectionId`, with room above it for the sticky header.
 */
export async function scrollToResponse(bodyId: string, sectionId: string): Promise<void> {
    await nextTick()

    window.setTimeout(() => {
        const targetElement = document.getElementById(bodyId) ?? document.getElementById(sectionId)
        if (!targetElement) return

        const scrollContainer = findScrollContainer()
        if (scrollContainer) {
            const rect = targetElement.getBoundingClientRect()
            const containerRect = scrollContainer.getBoundingClientRect()
            const scrollTop = scrollContainer.scrollTop + rect.top - containerRect.top - 96

            scrollContainer.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
            return
        }

        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    }, 120)
}

/** A response body as shown: text as it is, anything else as indented JSON, nothing as ''. */
export function formatResponseBody(data: unknown): string {
    if (data === undefined) return ''
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
}
