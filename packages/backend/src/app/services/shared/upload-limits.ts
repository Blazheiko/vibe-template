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
