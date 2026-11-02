/** The text of an ArrayBuffer, as uWebSockets.js hands out messages and addresses. */
export const ab2str = (
    buffer: ArrayBuffer,
    encoding: BufferEncoding | undefined = 'utf8',
): string => Buffer.from(buffer).toString(encoding)
