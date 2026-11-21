import { createRouter, createWebHistory } from 'vue-router'
import { redirectWithoutUrlToken } from '@/utils/one-time-url-token'
import { scrollToHash } from '@/utils/scroll-to-hash'
import type { RouteRecordRaw } from 'vue-router'
import Login from '@/views/Login.vue'
import UserAccount from '@/views/UserAccount.vue'
import ManifestoSocial from '@/views/ManifestoSocial.vue'
import SupportView from '@/views/SupportView.vue'
import AdminLayout from '@/views/admin/AdminLayout.vue'
import AdminKnowledgeBaseView from '@/views/admin/AdminKnowledgeBaseView.vue'
import AdminUsersView from '@/views/admin/AdminUsersView.vue'
import AdminUserOnlineView from '@/views/admin/AdminUserOnlineView.vue'
import AdminHistoryOnlineView from '@/views/admin/AdminHistoryOnlineView.vue'
import { adminRedirect } from '@/views/admin/admin-pages'
import VerifyEmailView from '@/views/VerifyEmailView.vue'
import ResetPasswordView from '@/views/ResetPasswordView.vue'
import OAuthLinkConfirmView from '@/views/OAuthLinkConfirmView.vue'
import { useUserStore, waitForApp } from '@/stores/user'

// Не вызывайте store вне функции навигационной защиты
// const userStore = useUserStore()
const routes: RouteRecordRaw[] = [
    {
        path: '/',
        name: 'Home',
        component: Login,
    },
    {
        path: '/login',
        name: 'Login',
        component: Login,
        meta: { authModal: 'login' },
    },
    {
        path: '/register',
        name: 'Register',
        component: Login,
        meta: { authModal: 'register' },
    },
    {
        path: '/verify-email',
        name: 'VerifyEmail',
        component: VerifyEmailView,
        meta: { hideHeader: true },
    },
    {
        // feat-097: the mailed link that confirms an OAuth sign-in into an existing account.
        path: '/oauth/link/confirm',
        name: 'OAuthLinkConfirm',
        component: OAuthLinkConfirmView,
        meta: { hideHeader: true },
    },
    {
        path: '/reset-password',
        name: 'ResetPassword',
        component: ResetPasswordView,
        meta: { hideHeader: true },
    },
    {
        path: '/support',
        name: 'Support',
        component: SupportView,
        meta: {
            requiresAuth: true,
            title: 'Support',
            showBack: true,
        },
    },
    {
        path: '/account',
        name: 'UserAccount',
        component: UserAccount,
        meta: {
            requiresAuth: true,
            title: 'Account Settings',
            showBack: true,
        },
    },
    // feat-236 (Р7, Р11): the notification center.
    {
        path: '/notifications',
        name: 'Notifications',
        component: () => import('@/views/NotificationsView.vue'),
        meta: { requiresAuth: true, title: 'Notifications', showBack: true },
    },
    {
        path: '/notifications/:id/open',
        name: 'NotificationOpen',
        component: () => import('@/views/NotificationOpenView.vue'),
        meta: { requiresAuth: true, title: 'Notifications' },
    },
    {
        path: '/about',
        name: 'About',
        component: ManifestoSocial,
    },
    {
        path: '/privacy-policy',
        name: 'PrivacyPolicy',
        component: () => import('@/views/PrivacyPolicy.vue'),
        meta: { title: 'Privacy Policy', hideHeader: true },
    },
    {
        path: '/terms',
        name: 'TermsAndConditions',
        component: () => import('@/views/TermsAndConditions.vue'),
        meta: { title: 'Terms and Conditions', hideHeader: true },
    },
    {
        path: '/cookies',
        name: 'CookiesPolicy',
        component: () => import('@/views/CookiesPolicy.vue'),
        meta: { title: 'Cookies Policy', hideHeader: true },
    },
    {
        path: '/ai-policy',
        name: 'AiPolicy',
        component: () => import('@/views/AiPolicy.vue'),
        meta: { title: 'AI & Content Policy', hideHeader: true },
    },
    {
        path: '/admin',
        component: AdminLayout,
        // feat-240: `/admin` itself goes to the first page the role may see (the guard below).
        meta: { requiresAuth: true, requiresStaff: true, hideHeader: true },
        children: [
            {
                path: 'knowledge-base',
                name: 'AdminKnowledgeBase',
                component: AdminKnowledgeBaseView,
                meta: { permission: 'kb.read' },
            },
            {
                path: 'users',
                name: 'AdminUsers',
                component: AdminUsersView,
                meta: { permission: 'users.read' },
            },
            {
                path: 'user-online',
                name: 'AdminUserOnline',
                component: AdminUserOnlineView,
                meta: { permission: 'users.read' },
            },
            {
                path: 'history-online',
                name: 'AdminHistoryOnline',
                component: AdminHistoryOnlineView,
                meta: { permission: 'users.sensitive.read' },
            },
            {
                // feat-235: a lazy chunk of the admin area.
                path: 'audit-log',
                name: 'AdminAuditLog',
                component: () => import('@/views/admin/AdminAuditLogView.vue'),
                meta: { permission: 'audit.read.account' },
            },
        ],
    },
]

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
})

// feat-236 (Р7): `/account#sessions` from a notification opens the page at that section.
router.afterEach((to) => {
    if (to.hash !== '') void scrollToHash(to.hash)
})

// feat-205: the one-time token of a mailed link does not stay in the address. main.ts takes it
// out before the first navigation (strip-url-token.ts); this guard does the same for a
// navigation that carries one inside the application. The page reads it with readUrlToken.
router.beforeEach((to) => redirectWithoutUrlToken(to) as never)

// Ждём initializeApp только для защищённых маршрутов, чтобы публичные token-flow
// страницы не зависали до инициализации auth.
router.beforeEach(async (to, _from, next) => {
    const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
    const requiresStaff = to.matched.some((record) => record.meta.requiresStaff)
    const requiresAppReady = requiresAuth || requiresStaff

    if (requiresAppReady) {
        await waitForApp()
    }

    const userStore = useUserStore()
    const isAuthenticated = userStore.hasUser()

    if (requiresAuth && !isAuthenticated) {
        const redirect = to.fullPath !== '/' ? to.fullPath : undefined
        next(redirect !== undefined ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login')
    } else if (requiresStaff) {
        // feat-240 (Р10): a page the role may not see goes to the first one it may.
        const redirect = adminRedirect(to.path, to.meta.permission, userStore.user?.role)
        if (redirect !== null) next(redirect)
        else next()
    } else {
        next()
    }
})

export default router
