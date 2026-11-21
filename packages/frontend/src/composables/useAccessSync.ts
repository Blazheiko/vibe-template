import { watch } from 'vue'
import type { Router } from 'vue-router'
import type { Role } from 'shared/access'

import { useUserStore } from '@/stores/user'
import { useEventBus } from '@/utils/event-bus'
import { accountApi } from '@/utils/api'
import { hasResponseError } from '@/utils/response-normalizer'
import { adminRedirect } from '@/views/admin/admin-pages'

// feat-240 (docs/plan/roles-permissions-plan.md Р8, Р10): the role of the signed-in user in this
// tab follows the server.
//
// - `access_changed` comes from this tab's own socket after the server applied the role to it:
//   the main source, also when the role change signal between instances was lost.
// - GET /account/access is read again on every `ws_ready` (a new socket reads its role when it
//   opens) and when the tab is shown again. Its answer is applied only when no `access_changed`
//   came and the account did not change since the read started (the store's ticket).
// - A role change re-checks the route shown now: a page the role may no longer see is left.

export interface AccessSyncDeps {
    fetchRole(): Promise<Role | null>
    currentPath(): { path: string; permission: Parameters<typeof adminRedirect>[1]; staff: boolean }
    replace(path: string): void
}

export function createAccessSync(deps: AccessSyncDeps) {
    const userStore = useUserStore()

    const readAgain = async (): Promise<void> => {
        if (userStore.user === null) return
        const ticket = userStore.beginAccessRead()
        const role = await deps.fetchRole()
        if (role !== null) userStore.applyAccessRead(ticket, role)
    }

    const recheckRoute = (): void => {
        const current = deps.currentPath()
        if (!current.staff) return
        const target = adminRedirect(current.path, current.permission, userStore.user?.role)
        if (target !== null && target !== current.path) deps.replace(target)
    }

    return { readAgain, recheckRoute }
}

async function fetchRole(): Promise<Role | null> {
    const { data, error } = await accountApi.getAccess()
    if (error !== null || data === null || hasResponseError(data) || data.status !== 'success') {
        return null
    }
    return data.role
}

/** Called once by App.vue. */
export function useAccessSync(router: Router): void {
    const userStore = useUserStore()
    const eventBus = useEventBus()
    const sync = createAccessSync({
        fetchRole,
        currentPath: () => {
            const route = router.currentRoute.value
            return {
                path: route.path,
                permission: route.meta.permission,
                staff: route.matched.some((record) => record.meta.requiresStaff),
            }
        },
        replace: (path) => {
            void router.replace(path)
        },
    })

    eventBus.on('access_changed', ({ role }) => {
        userStore.applyAccessChanged(role)
    })
    eventBus.on('ws_ready', () => {
        void sync.readAgain()
    })
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') void sync.readAgain()
        })
    }
    watch(
        () => userStore.user?.role,
        (role, previous) => {
            if (role !== previous) sync.recheckRoute()
        },
    )
}
