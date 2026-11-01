import type { HttpContext, WsContext } from '#vendor/types/types.js'

/**
 * Извлекает типизированный payload из контекста.
 * Тип payload выводится автоматически из generic параметра контекста.
 * Предполагает что валидация уже выполнена в server.ts
 */
export function getTypedPayload<TPayload>(
    context: HttpContext<TPayload> | WsContext<TPayload>,
): TPayload {
    const payload = 'httpData' in context ? context.httpData.payload : context.wsData.payload

    if (payload === null) {
        throw new Error('Payload is missing')
    }

    // Runtime validation happens before this helper is called.
    return payload as TPayload
}
