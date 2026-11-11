import { defineStore } from 'pinia'
import { apiUrl } from '@/utils/api-path'
import { ref, computed } from 'vue'
import { useApiSettingsStore } from './api-settings'
import { normalizePath } from '@/utils/api-helpers'

export interface RouteParameter {
    name: string
    type: string
    required: boolean
}

export interface SchemaField {
    name: string
    type: string
    required: boolean
}

export interface ArkSchema {
    expression: string
    fields: SchemaField[]
    jsonSchema?: unknown
}

export interface RateLimit {
    windowMs: number
    maxRequests: number
}

export interface BodyLimit {
    kind: string
    maxBytes: number
}

export interface ApiRoute {
    id: number
    url: string
    method: string
    description?: string
    handler: null
    middlewares?: string[]
    rateLimit?: RateLimit
    groupRateLimit?: RateLimit
    inputSchema?: ArkSchema
    querySchema?: ArkSchema
    outputSchema?: ArkSchema
    // Only routes that read a body; [] = no allowed body type.
    bodyLimits?: BodyLimit[]
    fullUrl?: string
    isSelected: boolean
}

export interface ApiGroup {
    prefix: string
    description: string
    middlewares?: string[]
    rateLimit?: RateLimit
    group: (ApiRoute | ApiGroup)[] // Support for nested groups
    fullPrefix?: string // Full prefix including parent groups
}

function isApiGroup(item: ApiRoute | ApiGroup): item is ApiGroup {
    return 'group' in item
}

function isApiRoute(item: ApiRoute | ApiGroup): item is ApiRoute {
    return !isApiGroup(item)
}

export const useApiStore = defineStore('api', () => {
    // State
    const httpRouteGroups = ref<ApiGroup[]>([])
    const wsRouteGroups = ref<ApiGroup[]>([])
    const flatHttpRoute = ref<ApiRoute[]>([])
    const flatWsRoute = ref<ApiRoute[]>([])
    const pathPrefix = ref<string>('')
    const isLoading = ref(false)
    const error = ref<string | null>(null)
    const currentRouteType = ref<'http' | 'ws'>('http')
    const searchTerm = ref('')
    const expandedRoute = ref<number | null>(null) // Route ID
    const activeRoute = ref<number | null>(null) // Route ID
    const selectedRouteId = ref<number | null>(null) // Selected route ID

    // Helper functions for handling nested groups
    // function normalizePrefix(parentPrefix: string): string {
    //   if (!parentPrefix) return ''
    //   let normalizedPrefix = parentPrefix
    //   if (parentPrefix.endsWith('/')) {
    //     normalizedPrefix = parentPrefix.slice(0, -1)
    //   }
    //   if (parentPrefix.startsWith('/')) {
    //     normalizedPrefix = parentPrefix.slice(1)
    //   }

    //   return normalizedPrefix
    // }

    let currentId = 0
    function getNextId(): number {
        return ++currentId
    }
    const groupsHttp = ref<ApiGroup[]>([])
    const groupsWs = ref<ApiGroup[]>([])

    function createGroupRoute(groups: ApiGroup[], group: ApiGroup, parentPrefix = '') {
        const groupRoutes = groupRouteHandler(groups, group.group, parentPrefix)
        const groupItem = {
            ...group,
            group: groupRoutes,
        }
        groups.push(groupItem)
    }

    function groupRouteHandler(
        groups: ApiGroup[],
        groupRoutes: (ApiRoute | ApiGroup)[],
        parentPrefix = '',
    ): ApiRoute[] {
        const routes: ApiRoute[] = []
        const normalizedParentPrefix = parentPrefix ? normalizePath(parentPrefix) : ''
        if (!Array.isArray(groupRoutes)) throw new Error('groupRoutes is not an array')

        for (const item of groupRoutes) {
            if (isApiGroup(item)) {
                createGroupRoute(
                    groups,
                    item,
                    `${normalizedParentPrefix}/${normalizePath(item.prefix)}`,
                )
            } else {
                const route = item
                // Use existing ID or create new one
                const id = route.id || getNextId()
                route.id = id

                routes.push({
                    ...route,
                    fullUrl: `${normalizedParentPrefix}/${normalizePath(route.url)}`,
                    isSelected: false,
                })
            }
        }

        return routes
    }

    // Computed
    const currentRouteGroups = computed(() => {
        return currentRouteType.value === 'http' ? httpRouteGroups.value : wsRouteGroups.value
    })

    // Computed for central part - uses linear group structure from groupRouteHandler
    const centralGroups = computed(() => {
        const currentGroups = currentRouteType.value === 'http' ? groupsHttp.value : groupsWs.value

        if (!searchTerm.value) {
            return currentGroups
        }

        // Filter groups by search query
        const term = searchTerm.value.toLowerCase()
        return currentGroups
            .map((group) => {
                const filteredRoutes = group.group.filter((item) => {
                    // Check that this is a route, not a group
                    if (isApiGroup(item)) return false

                    const route = item
                    return (
                        route.url.toLowerCase().includes(term) ||
                        route.description?.toLowerCase().includes(term) ||
                        route.fullUrl?.toLowerCase().includes(term)
                    )
                })

                return {
                    ...group,
                    group: filteredRoutes,
                }
            })
            .filter((group) => group.group.length > 0)
    })

    // Computed for tree structure (for SiteNavigation)
    const filteredTreeGroups = computed(() => {
        if (!searchTerm.value) {
            return currentRouteGroups.value
        }

        const term = searchTerm.value.toLowerCase()

        function filterTreeGroups(groups: ApiGroup[]): ApiGroup[] {
            return groups
                .map((group) => {
                    const filteredRoutes = group.group.filter((item) => {
                        if (isApiGroup(item)) return true // Always show groups

                        const route = item

                        return (
                            route.url.toLowerCase().includes(term) ||
                            route.description?.toLowerCase().includes(term)
                        )
                    })

                    return { ...group, group: filteredRoutes }
                })
                .filter((group) => group.group.length > 0)
        }

        return filterTreeGroups(currentRouteGroups.value)
    })

    // Computed for flat list of routes (for OnThisPage)
    const filteredFlatRoutes = computed(() => {
        if (!searchTerm.value) {
            return currentRouteType.value === 'http' ? flatHttpRoute.value : flatWsRoute.value
        }

        const term = searchTerm.value.toLowerCase()
        const currentFlatRoutes =
            currentRouteType.value === 'http' ? flatHttpRoute.value : flatWsRoute.value

        return currentFlatRoutes.filter((route) => {
            return (
                route.url.toLowerCase().includes(term) ||
                route.description?.toLowerCase().includes(term) ||
                route.fullUrl?.toLowerCase().includes(term)
            )
        })
    })

    // Computed for getting selected route
    const selectedRoute = computed(() => {
        if (selectedRouteId.value === null) {
            return null
        }
        return findRouteById(selectedRouteId.value)
    })

    // Set IDs for all routes in tree structure
    function assignIdsToTreeRoutes(groups: ApiGroup[]) {
        for (const group of groups) {
            for (const item of group.group) {
                if (isApiGroup(item)) {
                    // Recursively process nested groups
                    assignIdsToTreeRoutes([item])
                } else {
                    // Set ID for route
                    if (!item.id) {
                        item.id = getNextId()
                    }
                }
            }
        }
    }

    // Merge top-level groups with the same prefix into one group
    function mergeGroupsByPrefix(groups: ApiGroup[]): ApiGroup[] {
        const merged = new Map<string, ApiGroup>()
        for (const group of groups) {
            const existing = merged.get(group.prefix)
            if (existing) {
                existing.group = [...existing.group, ...group.group]
            } else {
                merged.set(group.prefix, { ...group, group: [...group.group] })
            }
        }
        return Array.from(merged.values())
    }

    // Actions
    async function fetchRoutes() {
        isLoading.value = true
        error.value = null

        try {
            const response = await fetch(
                apiUrl(useApiSettingsStore().settings.baseUrl, 'doc/routes'),
            )

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }

            const data = await response.json()

            httpRouteGroups.value = mergeGroupsByPrefix(data.httpRoutes || [])
            wsRouteGroups.value = mergeGroupsByPrefix(data.wsRoutes || [])
            pathPrefix.value = normalizePath(data.pathPrefix || '')

            assignIdsToTreeRoutes(httpRouteGroups.value)
            assignIdsToTreeRoutes(wsRouteGroups.value)

            // Process groups to create flat structure
            groupsHttp.value = []
            groupsWs.value = []
            groupRouteHandler(groupsHttp.value, httpRouteGroups.value, pathPrefix.value)
            flatHttpRoute.value = groupsHttp.value.flatMap((group) =>
                group.group.filter(isApiRoute),
            )
            groupRouteHandler(groupsWs.value, wsRouteGroups.value, pathPrefix.value)
            flatWsRoute.value = groupsWs.value.flatMap((group) => group.group.filter(isApiRoute))

            console.log('📊 Linear groups structure (for central display):')
            console.log('  HTTP groups:', groupsHttp.value.length)
            console.log('  WS groups:', groupsWs.value.length)

            if (groupsHttp.value.length > 0) {
                const firstGroup = groupsHttp.value[0]
                console.log('  Sample HTTP group:', {
                    prefix: firstGroup.prefix,
                    description: firstGroup.description,
                    routesCount: firstGroup.group.filter(isApiRoute).length,
                })
            }
            const apiSettingsStore = useApiSettingsStore()
            apiSettingsStore.setPathPrefix(pathPrefix.value)

            console.log('📊 Flat routes (for navigation):')
            console.log('  HTTP routes:', flatHttpRoute.value.length)
            console.log('  WS routes:', flatWsRoute.value.length)

            console.log('📘 API Documentation Loaded:', {
                httpRouteGroups: httpRouteGroups.value.length,
                wsRouteGroups: wsRouteGroups.value.length,
                flatHttpRoutes: flatHttpRoute.value.length,
                flatWsRoutes: flatWsRoute.value.length,
            })
        } catch (err) {
            error.value = err instanceof Error ? err.message : 'Failed to load API documentation'
            console.error('Error fetching route data:', err)
        } finally {
            isLoading.value = false
        }
    }

    function setRouteType(type: 'http' | 'ws') {
        currentRouteType.value = type
    }

    function setSearchTerm(term: string) {
        searchTerm.value = term
    }

    function setExpandedRoute(routeId: number) {
        expandedRoute.value = routeId
    }

    function collapseAllRoutes() {
        expandedRoute.value = null
    }

    function isRouteExpanded(routeId: number): boolean {
        return expandedRoute.value === routeId
    }

    function setActiveRoute(routeId: number) {
        activeRoute.value = routeId
    }

    function clearActiveRoute() {
        activeRoute.value = null
    }

    function isRouteActive(routeId: number): boolean {
        return activeRoute.value === routeId
    }

    function clearSelectedRoutes(routes: ApiRoute[]) {
        routes.forEach((route) => (route.isSelected = false))
    }

    function setSelectedRoute(routeId: number) {
        if (isNaN(routeId) || routeId <= 0) {
            console.error('Invalid routeId provided to setSelectedRoute:', routeId)
            return
        }

        clearSelectedRoutes(
            currentRouteType.value === 'http' ? flatHttpRoute.value : flatWsRoute.value,
        )
        selectedRouteId.value = routeId
        const route = findRouteById(routeId)
        if (route) {
            route.isSelected = true
        } else {
            console.error('Route not found for routeId:', routeId)
        }
    }

    function clearSelectedRoute() {
        selectedRouteId.value = null
    }

    function isRouteSelected(routeId: number): boolean {
        return selectedRouteId.value === routeId
    }

    function findRouteById(routeId: number): ApiRoute | null {
        const currentFlatRoutes =
            currentRouteType.value === 'http' ? flatHttpRoute.value : flatWsRoute.value
        return currentFlatRoutes.find((route) => route.id === routeId) ?? null
    }

    function findRouteByFullUrl(fullUrl: string, method: string): ApiRoute | null {
        const currentFlatRoutes =
            currentRouteType.value === 'http' ? flatHttpRoute.value : flatWsRoute.value
        return (
            currentFlatRoutes.find(
                (route) => route.fullUrl === fullUrl && route.method === method,
            ) ?? null
        )
    }

    async function scrollToRouteWithCollapse(routeId: number, elementId?: string) {
        // Set active route
        setActiveRoute(routeId)

        // First collapse all open routes
        collapseAllRoutes()

        // Wait for next tick to update DOM
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Then expand the needed route
        setExpandedRoute(routeId)

        // Wait another tick for complete DOM update
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Now perform scroll to element
        const targetElementId = elementId || `route-${routeId}`
        scrollToElement(targetElementId)
    }

    function scrollToElement(elementId: string, offset = 100) {
        const element = document.getElementById(elementId)
        if (element) {
            // Find main container with overflow-y-auto
            const mainContent = document.querySelector('main')
            if (mainContent) {
                // Get element position relative to main container
                const elementRect = element.getBoundingClientRect()
                const containerRect = mainContent.getBoundingClientRect()

                // Calculate needed scroll position
                const targetScrollTop =
                    mainContent.scrollTop + elementRect.top - containerRect.top - offset

                // Perform scroll
                mainContent.scrollTo({
                    top: Math.max(0, targetScrollTop),
                    behavior: 'smooth',
                })
            } else {
                // Fallback: use standard scrollIntoView
                element.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                    inline: 'nearest',
                })
            }
        }
    }

    return {
        // State
        httpRouteGroups,
        wsRouteGroups,
        flatHttpRoute,
        flatWsRoute,
        pathPrefix,
        isLoading,
        error,
        currentRouteType,
        searchTerm,
        expandedRoute,
        activeRoute,
        selectedRouteId,
        // Computed
        currentRouteGroups,
        centralGroups,
        filteredTreeGroups,
        filteredFlatRoutes,
        selectedRoute,
        // Actions
        fetchRoutes,
        setRouteType,
        setSearchTerm,
        setExpandedRoute,
        collapseAllRoutes,
        isRouteExpanded,
        setActiveRoute,
        clearActiveRoute,
        isRouteActive,
        setSelectedRoute,
        clearSelectedRoute,
        clearSelectedRoutes,
        isRouteSelected,
        findRouteById,
        findRouteByFullUrl,
        scrollToRouteWithCollapse,
        scrollToElement,
    }
})
