// Numeric limits that the backend enforces and the frontend shows. A module of its own,
// with no schema library behind it: the browser bundle can import it without pulling in
// the validation engine that `shared/schemas` needs.

/**
 * Longest support chat message, in characters. Every message goes to a language model
 * (translation, embedding, the answer, and again as history), so it is bounded.
 */
export const SUPPORT_MESSAGE_MAX_LENGTH = 4000
