import { describe, expect, it } from 'vitest'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_KIND_NAMES } from 'shared/notifications'

import en from '../en'
import pl from '../pl'
import uk from '../uk'

// feat-236 (Р3): every kind of the catalog has a title and a body in every language, and every
// category a name for the preferences.
describe.each([
    ['en', en],
    ['uk', uk],
    ['pl', pl],
])('notification texts in %s', (_code, messages) => {
    it.each(NOTIFICATION_KIND_NAMES)('%s has a title and a body', (kind) => {
        const key = kind.replace(/\./g, '_') as keyof typeof messages.notifications.kinds
        const text = messages.notifications.kinds[key]
        expect(text.title.trim()).not.toBe('')
        expect(text.body.trim()).not.toBe('')
    })

    it('every category is named', () => {
        for (const category of NOTIFICATION_CATEGORIES) {
            expect(messages.notifications.preferences.categories[category].trim()).not.toBe('')
        }
    })

    it('has no kind the catalog does not know', () => {
        expect(Object.keys(messages.notifications.kinds).sort()).toEqual(
            NOTIFICATION_KIND_NAMES.map((kind) => kind.replace(/\./g, '_')).sort(),
        )
    })
})
