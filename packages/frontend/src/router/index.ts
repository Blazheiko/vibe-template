import { createRouter, createWebHistory } from 'vue-router'
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
        meta: { requiresAuth: true, requiresAdmin: true, hideHeader: true },
        redirect: '/admin/knowledge-base',
        children: [
            {
                path: 'knowledge-base',
                name: 'AdminKnowledgeBase',
                component: AdminKnowledgeBaseView,
            },
            {
                path: 'users',
                name: 'AdminUsers',
                component: AdminUsersView,
            },
            {
                path: 'user-online',
                name: 'AdminUserOnline',
                component: AdminUserOnlineView,
            },
            {
                path: 'history-online',
                name: 'AdminHistoryOnline',
                component: AdminHistoryOnlineView,
            },
        ],
    },
]

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
})

// Ждём initializeApp только для защищённых маршрутов, чтобы публичные token-flow
// страницы не зависали до инициализации auth.
router.beforeEach(async (to, _from, next) => {
    const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
    const requiresAdmin = to.matched.some((record) => record.meta.requiresAdmin)
    const requiresAppReady = requiresAuth || requiresAdmin

    if (requiresAppReady) {
        await waitForApp()
    }

    const userStore = useUserStore()
    const isAuthenticated = userStore.hasUser()

    if (requiresAuth && !isAuthenticated) {
        const redirect = to.fullPath !== '/' ? to.fullPath : undefined
        next(redirect !== undefined ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login')
    } else if (requiresAdmin && (!isAuthenticated || !userStore.isAdmin())) {
        next('/account')
    } else {
        next()
    }
})

export default router
