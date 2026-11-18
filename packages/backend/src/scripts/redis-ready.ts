// feat-222: a CLI talks to Redis right after the process starts. The main client has no offline
// queue (fail-fast for requests), so a command sent while it is still connecting fails with
// "Redis unavailable". A script waits for the connection first, up to a bound.

export interface ReadyClient {
    readonly status: string
    once(event: 'ready', listener: () => void): unknown
    off(event: 'ready', listener: () => void): unknown
}

export function waitForRedisReady(client: ReadyClient, timeoutMs = 5_000): Promise<void> {
    if (client.status === 'ready') return Promise.resolve()
    return new Promise((resolve, reject) => {
        const onReady = (): void => {
            clearTimeout(timer)
            resolve()
        }
        const timer = setTimeout(() => {
            client.off('ready', onReady)
            reject(new Error(`Redis did not become ready within ${String(timeoutMs)} ms`))
        }, timeoutMs)
        client.once('ready', onReady)
    })
}
