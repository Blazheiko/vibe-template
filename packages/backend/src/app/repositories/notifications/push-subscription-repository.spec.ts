import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-058 (phase A): update() and deactivate() answer from their own owner-scoped UPDATE.
// When the WHERE (id AND user_id) matches nothing there is no row to return, and nothing may be
// read back by id alone: that read handed out another user's subscription.

const returning = vi.fn()
const where = vi.fn(() => ({ returning }))
const set = vi.fn(() => ({ where }))
const update = vi.fn(() => ({ set }))
// Anything else on `db` (a select to re-read the row) is not there, and throws
const db = { update }

vi.mock('#database/db.js', () => ({ db }))

const { pushSubscriptionRepository } = await import('./push-subscription-repository.js')

beforeEach(() => {
    returning.mockReset()
    where.mockClear()
    set.mockClear()
    update.mockClear()
})

describe('pushSubscriptionRepository.update', () => {
    it('is undefined when the owner-scoped UPDATE matched no row, and reads nothing back', async () => {
        returning.mockResolvedValue([])

        await expect(
            pushSubscriptionRepository.update(1n, 2n, { isActive: false }),
        ).resolves.toBeUndefined()

        expect(update).toHaveBeenCalledTimes(1)
        expect(where).toHaveBeenCalledTimes(1)
    })

    it('is the row that the UPDATE returned', async () => {
        const row = { id: 1n, userId: 2n, isActive: false }
        returning.mockResolvedValue([row])

        await expect(pushSubscriptionRepository.update(1n, 2n, { isActive: false })).resolves.toBe(
            row,
        )
    })

    it('stamps updatedAt and lastUsedAt together with the changed fields', async () => {
        returning.mockResolvedValue([])

        await pushSubscriptionRepository.update(1n, 2n, { timezone: 'Europe/Kyiv' })

        const changes = (set.mock.calls[0] as unknown[])[0] as Record<string, unknown>
        expect(changes['timezone']).toBe('Europe/Kyiv')
        expect(changes['updatedAt']).toBeInstanceOf(Date)
        expect(changes['lastUsedAt']).toBeInstanceOf(Date)
    })
})

describe('pushSubscriptionRepository.deactivate', () => {
    it('is undefined when the owner-scoped UPDATE matched no row, and reads nothing back', async () => {
        returning.mockResolvedValue([])

        await expect(pushSubscriptionRepository.deactivate(1n, 2n)).resolves.toBeUndefined()

        expect(update).toHaveBeenCalledTimes(1)
    })

    it('is the row that the UPDATE returned, now inactive', async () => {
        const row = { id: 1n, userId: 2n, isActive: false }
        returning.mockResolvedValue([row])

        await expect(pushSubscriptionRepository.deactivate(1n, 2n)).resolves.toBe(row)
        expect((set.mock.calls[0] as unknown[])[0]).toMatchObject({ isActive: false })
    })
})
