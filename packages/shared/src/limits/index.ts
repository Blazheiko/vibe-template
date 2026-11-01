// Numeric limits that the backend enforces and the frontend shows. A module of its own,
// with no schema library behind it: the browser bundle can import it without pulling in
// the validation engine that `shared/schemas` needs.

/**
 * Longest support chat message, in characters. Every message goes to a language model
 * (translation, embedding, the answer, and again as history), so it is bounded.
 */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4000

/** Messages in the first page of the support chat history, when the client does not ask for more. */
export const SUPPORT_HISTORY_DEFAULT_PAGE_SIZE = 50

/** Most messages one page of the support chat history may carry. */
export const SUPPORT_HISTORY_MAX_PAGE_SIZE = 100

/** Shortest and longest password, in characters; what the auth schemas of `shared/schemas` enforce. */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 32
