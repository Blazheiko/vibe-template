import AdminWsController from '#app/controllers/ws/admin-ws-controller.js'
import SupportWsController from '#app/controllers/ws/support-controller.js'
import { defineWsRoute } from '#app/routes/contract-schemas/index.js'
import { adminWsContracts, supportWsContracts } from 'shared/contracts'

// Every WS route is declared through its contract (ADR 0006): the event, payload and reply come
// from shared/contracts/ws.ts and the schema registry.
export default [
    {
        group: [
            defineWsRoute({
                contract: adminWsContracts.subscribeOnlineUsers,
                handler: AdminWsController.subscribeOnlineUsers.bind(AdminWsController),
                description: 'Subscribe current admin websocket to admin online updates',
            }),
            defineWsRoute({
                contract: adminWsContracts.unsubscribeOnlineUsers,
                handler: AdminWsController.unsubscribeOnlineUsers.bind(AdminWsController),
                description: 'Unsubscribe current admin websocket from admin online updates',
            }),
        ],
        prefix: 'admin',
        description: 'Admin websocket routes',
        middlewares: ['ws_admin_guard'],
        rateLimit: { windowMs: 60_000, maxRequests: 120 },
    },
    {
        group: [
            defineWsRoute({
                contract: supportWsContracts.openChat,
                handler: SupportWsController.openChat.bind(SupportWsController),
                description: 'Open support chat and trigger first greeting',
            }),
            defineWsRoute({
                contract: supportWsContracts.chat,
                handler: SupportWsController.chat.bind(SupportWsController),
                description: 'Send a message to the support agent',
            }),
        ],
        prefix: 'support',
        description: 'Support agent routes',
        rateLimit: { windowMs: 60_000, maxRequests: 60 },
    },
]
