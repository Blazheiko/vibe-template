import { expect, openLogin, test } from './support.js'

// feat-164 (review 2026-11-10): a modal is a dialog for the keyboard too. See support.ts.

test.describe('the sign-in modal and the keyboard', () => {
    test('is a labelled dialog and takes focus when it opens', async ({ page }) => {
        const modal = await openLogin(page)

        const dialog = page.getByRole('dialog', { name: 'Sign In' })
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute('aria-modal', 'true')
        await expect(modal.locator('#login-identifier')).toBeFocused()
    })

    test('Tab and Shift+Tab never leave the dialog', async ({ page }) => {
        await openLogin(page)
        const dialog = page.getByRole('dialog', { name: 'Sign In' })
        // The focused element is a control of the dialog.
        const focused = dialog.locator(':focus')

        for (let step = 0; step < 25; step++) {
            await page.keyboard.press('Tab')
            await expect(focused, `Tab ${String(step + 1)}`).toHaveCount(1)
        }
        for (let step = 0; step < 25; step++) {
            await page.keyboard.press('Shift+Tab')
            await expect(focused, `Shift+Tab ${String(step + 1)}`).toHaveCount(1)
        }
    })

    test('Escape closes it and focus returns to the button that opened it', async ({ page }) => {
        await openLogin(page)

        await page.keyboard.press('Escape')

        await expect(page.locator('.modal-overlay.show')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Sign In' }).first()).toBeFocused()
    })
})
