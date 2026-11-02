import { httpMiddlewares, wsMiddlewares } from '#app/middlewares/kernel.js'
import type { HttpContext, Middleware, WsContext } from '#vendor/types/types.js'

/** Runs the named middlewares in order; true when every one called `next`. */
const runMiddlewares = async <TContext>(
    middlewares: string[] | undefined,
    context: TContext,
    kernel: Readonly<Record<string, Middleware<TContext>>>,
): Promise<boolean> => {
    if (middlewares === undefined || middlewares.length === 0) {
        return true
    }
    let index = 0
    let counter = 0
    const next = async (): Promise<void> => {
        counter++
        if (index < middlewares.length) {
            const middlewareName = middlewares[index++]
            if (middlewareName === undefined) throw new Error('Middleware name is undefined')
            const middleware = kernel[middlewareName]
            if (middleware === undefined) throw new Error(`No middleware ${middlewareName}`)
            await middleware(context, next)
        }
    }
    await next()

    return middlewares.length === counter - 1
}

// One map per transport: a middleware gets the context type it was written for, and
// a route naming a middleware of the other transport fails like an unknown name.
const executeMiddlewares = (
    middlewares: string[] | undefined,
    context: HttpContext,
): Promise<boolean> => runMiddlewares(middlewares, context, httpMiddlewares)

export const executeWsMiddlewares = (
    middlewares: string[] | undefined,
    context: WsContext,
): Promise<boolean> => runMiddlewares(middlewares, context, wsMiddlewares)

export default executeMiddlewares
