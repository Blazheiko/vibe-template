import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

// feat-205 (security review 2026-11-12, L-17): what Sentry Session Replay sends about a page
// opened from a mailed link. The replay records the address of the page in events of the DOM
// recorder, which no hook of the SDK lets the application rewrite, so masking alone (feat-194)
// does not keep a `?token=` out of it. The token is taken out of the address before Sentry
// starts (utils/one-time-url-token.ts); this reads the real envelopes of the real SDK.
//
// The build has replay on and a DSN on the page's own origin (playwright.config.ts, project
// `sentry`); the envelopes are answered here.

const TOKEN = 'canary-reset-token-9d2e'

/** Everything readable in a Sentry envelope: the text parts, and compressed parts inflated. */
const readable = (body: Buffer): string => {
    const parts: string[] = [body.toString('latin1')]
    for (let i = 0; i < body.length; i += 1) {
        // A zlib (0x78) or gzip (0x1f 0x8b) stream may start anywhere after an item header.
        if (body[i] !== 0x78 && !(body[i] === 0x1f && body[i + 1] === 0x8b)) continue
        for (const inflate of [inflateSync, gunzipSync, inflateRawSync]) {
            try {
                parts.push(inflate(body.subarray(i)).toString('utf8'))
                break
            } catch {
                // not a stream at this offset
            }
        }
    }
    return parts.join('\n')
}

const collectEnvelopes = async (page: Page): Promise<string[]> => {
    const bodies: string[] = []
    await page.route('**/api/1/envelope/**', async (route) => {
        const body = route.request().postDataBuffer()
        if (body !== null) bodies.push(readable(body))
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    return bodies
}

/** The envelopes sent once the first replay segment is out. */
const replaySent = async (page: Page, bodies: string[]): Promise<string> => {
    // A segment goes out after the minimum replay duration; leaving the page flushes it.
    // A fixed wait on purpose: the SDK holds a segment back for its minimum duration (5 s),
    // and nothing on the page says when that has passed.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(6000)
    // As a string: the e2e TypeScript project has no DOM types.
    await page.evaluate(
        "document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur'))",
    )
    await expect
        .poll(() => bodies.some((body) => body.includes('replay_event')), { timeout: 20_000 })
        .toBe(true)
    return bodies.join('\n')
}

test('a replay of a page opened from a mailed link carries no token', async ({ page }) => {
    const bodies = await collectEnvelopes(page)

    await page.goto(`/reset-password?token=${TOKEN}&lang=uk`)

    // The token left the address at once; the other parameters stay.
    await expect(page).toHaveURL(/\/reset-password\?lang=uk$/)
    const sent = await replaySent(page, bodies)
    // The replay is about this page and has nothing of the token, in any envelope.
    expect(sent).toContain('reset-password')
    expect(sent).not.toContain(TOKEN)
    // The page still has its token: the form is shown, not "invalid link".
    await expect(page.locator('#reset-password')).toBeVisible()
})

test('the page keeps the token over a reload', async ({ page }) => {
    await collectEnvelopes(page)
    await page.goto(`/reset-password?token=${TOKEN}`)
    await expect(page.locator('#reset-password')).toBeVisible()

    await page.reload()

    await expect(page).toHaveURL(/\/reset-password$/)
    await expect(page.locator('#reset-password')).toBeVisible()
})

// The control for the first test: a token left in the address is in the replay, masking hooks
// or not. If this stops being true, the SDK changed and the first test proves less.
test('control: a token left in the address of another page reaches the replay', async ({
    page,
}) => {
    const bodies = await collectEnvelopes(page)

    await page.goto(`/privacy-policy?token=${TOKEN}`)

    const sent = await replaySent(page, bodies)
    expect(sent).toContain(TOKEN)
})
