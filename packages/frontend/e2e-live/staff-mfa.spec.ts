import { createHmac } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'

import { ORIGIN, USER_2 } from './fixtures'
import { createVerifiedAccount, expect, loginInUi, newBrowser, session, test } from './support'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11, Р13; tasks S4) against the real backend: a staff
// member with an authenticator app keeps the admin area open; the seeded admin resets their second
// factors; the session token rotates, the server closes the socket and the open admin tab leaves
// for the sign-in page.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const totp = (secret: string): string => {
    let bits = 0
    let value = 0
    const key: number[] = []
    for (const char of secret) {
        value = (value << 5) | BASE32.indexOf(char)
        bits += 5
        if (bits >= 8) {
            key.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
    const digest = createHmac('sha1', Buffer.from(key)).update(counter).digest()
    const at = (digest[digest.length - 1] ?? 0) & 0x0f
    const binary =
        (((digest[at] ?? 0) & 0x7f) << 24) |
        ((digest[at + 1] ?? 0) << 16) |
        ((digest[at + 2] ?? 0) << 8) |
        (digest[at + 3] ?? 0)
    return String(binary % 1_000_000).padStart(6, '0')
}

const post = async (request: APIRequestContext, path: string, data: unknown) => {
    const token = await session(request).token()
    return request.post(path, { data, headers: { origin: ORIGIN, 'x-csrf-token': token } })
}

test('an MFA reset by the admin closes the open admin tab of the staff member', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)

    // The staff member signs in (a fresh password) and sets up an authenticator app.
    const staff = await newBrowser(browser)
    await loginInUi(staff.page, account)
    const init = (await (await staff.context.request.get('/api/main/init')).json()) as {
        user: { id: string }
    }
    const setup = (await (
        await post(staff.context.request, '/api/account/mfa/totp/setup', {})
    ).json()) as {
        enrollmentId: string
        secret: string
    }
    const confirmed = await post(staff.context.request, '/api/account/mfa/totp/confirm', {
        enrollmentId: setup.enrollmentId,
        code: totp(setup.secret),
    })
    expect(confirmed.status()).toBe(200)

    // The admin makes them a support operator; their tab opens the admin area.
    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    const token = await session(admin.context.request).token()
    const promoted = await admin.context.request.patch(`/api/admin/users/${init.user.id}/role`, {
        data: { role: 'support_operator' },
        headers: { origin: ORIGIN, 'x-csrf-token': token },
    })
    expect(promoted.status()).toBe(200)
    await staff.page.goto('/admin/users')
    await expect(staff.page).toHaveURL(/\/admin\/users$/)
    await expect(staff.page.locator('.admin-sidebar')).toBeVisible()

    // The admin resets the factors (the sign-in a moment ago is the fresh proof).
    const reset = await post(admin.context.request, `/api/admin/users/${init.user.id}/mfa/reset`, {
        reason: 'lost the phone',
    })
    expect(reset.status()).toBe(200)
    expect(await reset.json()).toMatchObject({ removed: { totp: true, recoveryCodes: 10 } })

    // The staff tab: its socket is closed by the server and the tab leaves for the sign-in.
    await expect(staff.page).toHaveURL(/\/login/, { timeout: 15_000 })
    expect(await session(staff.context.request).whoAmI()).toBeNull()

    // The account signs in again with the password alone: no second step any more.
    const again = await newBrowser(browser)
    await loginInUi(again.page, account)
    await again.context.close()
    await staff.context.close()
    await admin.context.close()
})
