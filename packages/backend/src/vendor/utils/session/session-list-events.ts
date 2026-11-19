import logger from '#vendor/utils/logger.js'

// feat-233 (Р12): the session layer says when the list of a user's sessions changed (a sign-in,
// a logout). The app decides how the clients learn it (the user event bus); the session layer
// imports nothing of the app.

type Listener = (userId: string) => void

let listener: Listener | null = null

export const onSessionListChanged = (next: Listener | null): void => {
    listener = next
}

/** Best effort: a failing listener never fails the sign-in or logout that changed the list. */
export const sessionListChanged = (userId: string): void => {
    try {
        listener?.(userId)
    } catch (err) {
        logger.warn({ err, userId }, 'Session list change not announced')
    }
}
