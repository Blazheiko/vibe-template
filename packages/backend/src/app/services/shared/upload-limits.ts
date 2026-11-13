// Size limits of file uploads, shared by the routes (which cap the whole request body)
// and the services (which check the file itself).

/** Largest avatar file, in bytes. */
export const AVATAR_MAX_FILE_BYTES = 10 * 1024 * 1024

/** Largest knowledge-base screenshot, in bytes. */
export const KB_SCREENSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * Room for the multipart framing around the file: boundary lines, the part headers and a
 * few small text fields. A file of exactly the allowed size must fit in the body limit,
 * which a body limit equal to the file limit would not allow.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

/** The `maxBodySize` of a multipart route that accepts one file of at most `maxFileBytes`. */
export const multipartBodyLimit = (maxFileBytes: number): number =>
    maxFileBytes + MULTIPART_OVERHEAD_BYTES

// feat-202: a JSON route takes at most APP_DEFAULT_JSON_BODY_SIZE (100 KB) unless it says
// otherwise. The two routes below carry one long text field each.

/** Longest knowledge-base article content the schema accepts, in characters. */
const KB_ARTICLE_MAX_CONTENT_CHARS = 30_000
/** Longest prompt content the schema accepts, in characters. */
const PROMPT_MAX_CONTENT_CHARS = 50_000

/** Room for the other fields of the JSON body. */
const JSON_OVERHEAD_BYTES = 16 * 1024

/**
 * The `maxBodySize` of a JSON route with one text field of at most `maxChars` characters. A
 * character (a UTF-16 unit, which is what the schema counts) takes at most 3 bytes as UTF-8
 * and 6 when a client escapes it as `\uXXXX`: a text of exactly the allowed length must fit
 * however it was encoded.
 */
export const jsonBodyLimit = (maxChars: number): number => maxChars * 6 + JSON_OVERHEAD_BYTES

export const KB_ARTICLE_MAX_BODY_BYTES = jsonBodyLimit(KB_ARTICLE_MAX_CONTENT_CHARS)
export const PROMPT_MAX_BODY_BYTES = jsonBodyLimit(PROMPT_MAX_CONTENT_CHARS)
