import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { parse } from 'dotenv'

// feat-260: how mfa:keys reads and writes one variable of packages/backend/.env. It reads the
// file with dotenv, as the server does (`export`, spaces around `=`, comments, the last definition
// wins), and writes only a single plain `KEY=value` line, so what it writes is what the server
// reads.

/** The value the server reads from this .env content ('' when it is missing). */
export const readEnvKey = (content: string, key: string): string => parse(content)[key] ?? ''

const definitionPattern = (key: string): RegExp =>
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*(?:=|:)`)

/** A plain line mfa:keys can replace: `KEY=value` or `KEY="value"`, no export, no comment. */
const plainLinePattern = (key: string): RegExp =>
    new RegExp(`^${key}=(?:"[^"\\\\\\n]*"|[A-Za-z0-9+/=:,_-]*)\\s*$`)

/**
 * The content with `key` set to `value`, or why it is not written. One plain definition is
 * replaced, a missing one appended; any other form (several definitions, `export`, spaces, a
 * comment, a multi-line value) is refused, because rewriting it could leave the server reading a
 * different line than the one written. The result is checked by reading it back.
 */
export function setEnvKey(
    content: string,
    key: string,
    value: string,
): { ok: true; content: string } | { ok: false; error: string } {
    const lines = content.split('\n')
    const defined = lines.flatMap((line, index) =>
        definitionPattern(key).test(line) ? [index] : [],
    )
    const line = `${key}="${value}"`
    // A file with CRLF line ends keeps them: the new line ends like the rest of the file.
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    let result: string
    if (defined.length === 0) {
        const separator = content === '' || content.endsWith('\n') ? '' : eol
        result = `${content}${separator}${line}${eol}`
    } else {
        const [index] = defined
        if (
            defined.length > 1 ||
            index === undefined ||
            !plainLinePattern(key).test(lines[index] ?? '')
        ) {
            return {
                ok: false,
                error:
                    `${key} is not a single plain ${key}=… line in this file (several ` +
                    'definitions, export, spaces, a comment or a multi-line value); make it one ' +
                    'line first',
            }
        }
        lines[index] = (lines[index] ?? '').endsWith('\r') ? `${line}\r` : line
        result = lines.join('\n')
    }
    if (readEnvKey(result, key) !== value) {
        return { ok: false, error: `${key} would not read back as written; the file is kept` }
    }
    return { ok: true, content: result }
}

/**
 * The file a path names: a symlink is followed to its target, a dangling one included (its
 * target is created, the link is not replaced by a regular file).
 */
function resolveTarget(path: string): string {
    let current = path
    for (let depth = 0; depth < 40; depth += 1) {
        let stats
        try {
            stats = lstatSync(current)
        } catch {
            return current
        }
        if (!stats.isSymbolicLink()) return realpathSync(current)
        current = resolve(dirname(current), readlinkSync(current))
    }
    throw new Error(`${path}: too many symbolic links`)
}

/**
 * Runs read → update → write of a file under a lock file, so two runs cannot interleave, and
 * replaces the file atomically (a temporary file in the same directory, fsync, rename) with the
 * mode of the old one. `update` returns the new content, or null to leave the file as it is.
 * A symlink is followed, a dangling one too: its target is written, the link stays. A temporary
 * file is removed on any failure, so no copy of the secret is left behind.
 */
export function updateFileAtomically<T>(
    path: string,
    update: (content: string) => { content: string | null; result: T },
): T {
    const target = resolveTarget(path)
    const lock = `${target}.lock`
    let lockFd: number
    try {
        lockFd = openSync(lock, 'wx', 0o600)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
                `${lock} exists: another run is writing ${basename(target)}. If none is, delete ` +
                    'the lock file and run again.',
                { cause: err },
            )
        }
        throw err
    }
    try {
        const exists = existsSync(target)
        const content = exists ? readFileSync(target, 'utf8') : ''
        const { content: next, result } = update(content)
        if (next !== null) {
            const mode = exists ? statSync(target).mode & 0o777 : 0o600
            const temporary = join(
                dirname(target),
                `${basename(target)}.${String(process.pid)}.tmp`,
            )
            const fd = openSync(temporary, 'wx', mode)
            try {
                try {
                    writeSync(fd, next)
                    fsyncSync(fd)
                } finally {
                    closeSync(fd)
                }
                renameSync(temporary, target)
            } catch (err) {
                rmSync(temporary, { force: true })
                throw err
            }
        }
        return result
    } finally {
        closeSync(lockFd)
        unlinkSync(lock)
    }
}
