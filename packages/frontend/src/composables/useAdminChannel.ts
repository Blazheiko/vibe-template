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

    const ensure = async (): Promise<void> => {
        if (!deps.wanted()) return
        const generation = deps.generation()
        if (confirmedFor === generation || inFlightFor === generation) return
        inFlightFor = generation
        let ok = false
        try {
            ok = await deps.subscribe()
        } finally {
            if (inFlightFor === generation) inFlightFor = null
        }
        // An answer for a socket that is gone says nothing about the current one.
        if (deps.generation() !== generation) return
        if (ok && deps.wanted()) {
            confirmedFor = generation
            if (resumePending) {
                resumePending = false
                deps.onResumed()
            }
        }
    }

    const leave = async (): Promise<void> => {
        confirmedFor = null
        resumePending = false
        // Idempotent on the server, and allowed whatever the role: always sent.
        await deps.unsubscribe()
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
