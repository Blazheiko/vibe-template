// feat-149 (review 2026-11-10, M1): what one WebSocket connection may send in a minute.
//
// The per-route limiter runs in the dispatcher, after the message has already cost a Redis
// command (the token refresh) and, for a valid message, a session read with a PostgreSQL query —
// and it never runs for an unknown event. This budget is checked first, from memory: the state
// lives in the connection's user data, so it costs no I/O and ends with the socket.

const WINDOW_MS = 60_000

/** Heartbeats a minute that still refresh the WS token. The client sends one every 10 s. */
export const WS_PINGS_PER_MINUTE = 60

/**
 * Close code of a connection that keeps flooding. In the 4000–4099 range the client does not
 * reconnect (websocket-close.ts); 4001 is taken by "refresh the token".
 */
export const WS_CLOSE_MESSAGE_FLOOD = 4029

/** A connection is closed in the third minute in a row that went over its budget. */
const MAX_MINUTES_OVER_BUDGET = 3

export interface WsMessageBudgetLimits {
    readonly messagesPerMinute: number
    readonly maxConcurrentHandlers: number
}

export interface WsMessageBudgetState {
    windowStart: number
    messages: number
    pings: number
    /** Frames refused in this window, messages and pings together. */
    refused: number
    /** Windows over budget right before this one, without a clean one between. */
    minutesOverBudget: number
    /** Handlers of this connection that have not finished. */
    handlers: number
}

/**
 * - `allow`: a message was admitted and holds a handler slot (give it back with
 *   `releaseWsHandler`), or a ping may refresh the token.
 * - `refuse`: over the budget; nothing that costs I/O may run for this frame.
 * - `close`: the connection keeps flooding and is to be closed.
 */
export type WsAdmission = 'allow' | 'refuse' | 'close'

export const createWsMessageBudget = (now: number): WsMessageBudgetState => ({
    windowStart: now,
    messages: 0,
    pings: 0,
    refused: 0,
    minutesOverBudget: 0,
    handlers: 0,
})

const startWindowIfDue = (state: WsMessageBudgetState, now: number): void => {
    const elapsed = now - state.windowStart
    if (elapsed < WINDOW_MS) return
    // A window nobody wrote in is a clean one: the run of windows over budget is broken.
    const previousWasOver = state.refused > 0 && elapsed < 2 * WINDOW_MS
    state.minutesOverBudget = previousWasOver ? state.minutesOverBudget + 1 : 0
    state.windowStart = now
    state.messages = 0
    state.pings = 0
    state.refused = 0
}

const refuse = (state: WsMessageBudgetState, limits: WsMessageBudgetLimits): WsAdmission => {
    state.refused += 1
    // More than twice the budget within one minute, or over it minute after minute. Until then
    // a refused frame is answered, which costs a parse and a send; this bounds that too.
    const flooding =
        state.refused > limits.messagesPerMinute ||
        state.minutesOverBudget >= MAX_MINUTES_OVER_BUDGET - 1
    return flooding ? 'close' : 'refuse'
}

export const admitWsMessage = (
    state: WsMessageBudgetState,
    limits: WsMessageBudgetLimits,
    now: number,
): WsAdmission => {
    startWindowIfDue(state, now)
    state.messages += 1
    if (state.messages > limits.messagesPerMinute) return refuse(state, limits)
    if (state.handlers >= limits.maxConcurrentHandlers) return refuse(state, limits)
    state.handlers += 1
    return 'allow'
}

export const admitWsPing = (
    state: WsMessageBudgetState,
    limits: WsMessageBudgetLimits,
    now: number,
): WsAdmission => {
    startWindowIfDue(state, now)
    state.pings += 1
    if (state.pings > WS_PINGS_PER_MINUTE) return refuse(state, limits)
    return 'allow'
}

export const releaseWsHandler = (state: WsMessageBudgetState): void => {
    if (state.handlers > 0) state.handlers -= 1
}

/** Seconds until the connection gets a new budget, for the reply to a refused message. */
export const secondsToNextWindow = (state: WsMessageBudgetState, now: number): number =>
    Math.max(1, Math.ceil((state.windowStart + WINDOW_MS - now) / 1000))
