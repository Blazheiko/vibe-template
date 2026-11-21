import { onMounted, onUnmounted, watch } from 'vue'
import { adminWsContracts } from 'shared/contracts'

import { useUserStore } from '@/stores/user'
import { useEventBus } from '@/utils/event-bus'
import { callWs } from '@/utils/ws-client'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

// feat-240 (docs/plan/roles-permissions-plan.md Р8, Р10): the subscription of the admin area to the
// online updates (the WS channel `admin`).
//
// It is wanted while the admin area is mounted and the role has users.read, and confirmed for one
// socket: the last subscribe sent through that socket answered success. A new socket (its
// generation) has no subscription on the server, nor has a socket whose channel the server paused
// (`admin_channel_ready` comes after the pause), so both clear the confirmation. It is sent again
// when wanted and not confirmed, on: mounting, the permission appearing, `ws_ready`,
// `access_changed` (also with the role the store already has: a first subscribe may have reached
// the socket before its role was raised) and `admin_channel_ready`. A 403 leaves it unconfirmed
// without a retry loop; the next of those events tries again. An answer for an older socket is
// dropped. Leaving the area or losing the permission unsubscribes.
//
// Review 2026-11-21: one of those events arriving while a subscribe of the same socket is in
// flight is not lost: it asks for one more subscribe, sent after the current answer if that left
// the channel unconfirmed. `admin_channel_ready` also makes the answer in flight stale (it may
// precede the pause), so that answer confirms nothing and the retry decides.
//
// feat-243 (second review): leaving makes the answer in flight stale too (the unsubscribe may have
// reached the server after the subscribe it answers), and a subscribe waits for the unsubscribe
// still running, so the server never ends up unsubscribed behind a confirmed subscription.

export interface AdminChannelDeps {
    subscribe(): Promise<boolean>
    unsubscribe(): Promise<void>
    generation(): number
    wanted(): boolean
    /** After a successful subscribe that follows a pause: the list missed the events meanwhile. */
    onResumed(): void
}

export function createAdminChannel(deps: AdminChannelDeps) {
    let confirmedFor: number | null = null
    let inFlightFor: number | null = null
    let resumePending = false
    /** An event asked for a subscribe while one was in flight. */
    let retryRequested = false
    /**
     * Bumped by `admin_channel_ready` and by leaving: an answer to a subscribe sent before confirms
     * nothing (the server may have left the channel after answering it). feat-243.
     */
    let staleEpoch = 0
    /** The unsubscribe still running; the next subscribe is sent after it (feat-243). */
    let leaving: Promise<void> | null = null
    /** Reads and clears the retry asked for; a call, so the flag is read after the await. */
    const takeRetry = (): boolean => {
        const asked = retryRequested
        retryRequested = false
        return asked
    }

    const ensure = async (): Promise<void> => {
        if (!deps.wanted()) return
        const generation = deps.generation()
        if (confirmedFor === generation) return
        if (inFlightFor === generation) {
            retryRequested = true
            return
        }
        inFlightFor = generation
        retryRequested = false
        let sentInEpoch = staleEpoch
        let ok = false
        try {
            // A subscribe that overtook the unsubscribe would be undone by it on the server.
            while (leaving !== null) await leaving
            if (!deps.wanted()) return
            sentInEpoch = staleEpoch
            ok = await deps.subscribe()
        } finally {
            if (inFlightFor === generation) inFlightFor = null
        }
        // An answer for a socket that is gone says nothing about the current one.
        if (deps.generation() !== generation) return
        if (ok && deps.wanted() && sentInEpoch === staleEpoch) {
            confirmedFor = generation
            if (resumePending) {
                resumePending = false
                deps.onResumed()
            }
        }
        if (takeRetry()) await ensure()
    }

    const leave = async (): Promise<void> => {
        confirmedFor = null
        resumePending = false
        retryRequested = false
        staleEpoch += 1
        // Idempotent on the server, and allowed whatever the role: always sent.
        const unsubscribing = deps.unsubscribe().catch(() => undefined)
        leaving = unsubscribing
        try {
            await unsubscribing
        } finally {
            if (leaving === unsubscribing) leaving = null
        }
    }

    return {
        ensure,
        leave,
        /** The server paused the channel of this socket and may now let it in again. */
        onChannelReady: (): Promise<void> => {
            // The server left the channel for this socket during the pause: the generation is the
            // same, the subscription is not.
            confirmedFor = null
            resumePending = true
            staleEpoch += 1
            return ensure()
        },
        /** `access_changed`: the role of the socket was just changed on the server. */
        onAccessChanged: (): Promise<void> => (deps.wanted() ? ensure() : leave()),
        isConfirmed: (): boolean => confirmedFor !== null && confirmedFor === deps.generation(),
    }
}

/** For AdminLayout: keeps the subscription while it is mounted. */
export function useAdminChannel(onResumed: () => void = () => undefined): void {
    const userStore = useUserStore()
    const eventBus = useEventBus()
    const { socketGeneration, statusWebSocket } = useWebSocketConnection()
    let mounted = false

    const channel = createAdminChannel({
        subscribe: async () => {
            if (statusWebSocket.value !== 'OPEN') return false
            try {
                const reply = await callWs(adminWsContracts.subscribeOnlineUsers)
                // A refusal (403) is an answer, not a failure: callWs resolves with it.
                return reply.data?.status === 'success'
            } catch (error) {
                console.error('Failed to subscribe admin channel:', error)
                return false
            }
        },
        unsubscribe: async () => {
            if (statusWebSocket.value !== 'OPEN') return
            try {
                await callWs(adminWsContracts.unsubscribeOnlineUsers)
            } catch (error) {
                console.error('Failed to unsubscribe admin channel:', error)
            }
        },
        generation: () => socketGeneration.value,
        wanted: () => mounted && userStore.can('users.read'),
        onResumed,
    })

    const onReady = (): void => {
        void channel.ensure()
    }
    const onAccessChanged = (): void => {
        void channel.onAccessChanged()
    }
    const onChannelReady = (): void => {
        void channel.onChannelReady()
    }

    watch(
        () => userStore.can('users.read'),
        (may) => {
            if (may) void channel.ensure()
            else void channel.leave()
        },
    )

    onMounted(() => {
        mounted = true
        eventBus.on('ws_ready', onReady)
        eventBus.on('access_changed', onAccessChanged)
        eventBus.on('admin_channel_ready', onChannelReady)
        void channel.ensure()
    })
    onUnmounted(() => {
        mounted = false
        eventBus.off('ws_ready', onReady)
        eventBus.off('access_changed', onAccessChanged)
        eventBus.off('admin_channel_ready', onChannelReady)
        void channel.leave()
    })
}
