import { request } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import type { Agent } from 'node:https'

import webpush from 'web-push'
import type { PushSubscription, RequestOptions } from 'web-push'

// WebPushError keeps headers as plain strings, as web-push's own transport hands them over.
const flatHeaders = (headers: IncomingHttpHeaders): Record<string, string> =>
    Object.fromEntries(
        Object.entries(headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
        ),
    )

export interface PushTransportOptions {
    /** The whole request, from connect to the last byte of the answer. */
    deadlineMs: number
    vapidDetails?: RequestOptions['vapidDetails']
    /** Tests only (a throwaway CA). The app passes none: no proxy or agent (feat-104). */
    agent?: Agent
}

export interface PushTransportResponse {
    statusCode: number
}

/**
 * feat-139 (Q4): web-push's own `timeout` is the socket idle timeout, so a push service that
 * answers a byte at a time held the send for as long as it liked. This is the request web-push
 * makes (its request details: headers, encrypted body), sent with a deadline over the whole
 * exchange. Like web-push it does not follow redirects and rejects any status outside 2xx with a
 * WebPushError that carries the status code; the answer body is read and dropped.
 */
export function sendPush(
    subscription: PushSubscription,
    payload: string,
    options: PushTransportOptions,
): Promise<PushTransportResponse> {
    const details = webpush.generateRequestDetails(
        subscription,
        payload,
        options.vapidDetails === undefined ? {} : { vapidDetails: options.vapidDetails },
    )
    const url = new URL(details.endpoint)

    const signal = AbortSignal.timeout(options.deadlineMs)
    return new Promise((resolve, reject) => {
        // Past the deadline the reason (a TimeoutError) says what happened, not a bare abort.
        const fail = (err: unknown): void => {
            reject(signal.aborted ? (signal.reason as Error) : (err as Error))
        }
        const req = request(
            {
                hostname: url.hostname,
                port: url.port,
                path: `${url.pathname}${url.search}`,
                method: details.method,
                headers: details.headers,
                signal,
                ...(options.agent === undefined ? {} : { agent: options.agent }),
            },
            (res) => {
                const statusCode = res.statusCode ?? 0
                let body = ''
                res.setEncoding('utf8')
                res.on('data', (chunk: string) => {
                    if (body.length < 4096) body += chunk
                })
                res.on('error', fail)
                res.on('end', () => {
                    if (statusCode < 200 || statusCode > 299) {
                        reject(
                            new webpush.WebPushError(
                                'Received unexpected response code',
                                statusCode,
                                flatHeaders(res.headers),
                                body,
                                details.endpoint,
                            ),
                        )
                    } else {
                        resolve({ statusCode })
                    }
                })
            },
        )
        req.on('error', fail)
        req.write(details.body)
        req.end()
    })
}
