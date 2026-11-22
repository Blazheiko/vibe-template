import { createHmac } from 'node:crypto'

// feat-245/feat-247: the TOTP codes an authenticator app shows (RFC 6238: SHA-1, 30 s, 6 digits).
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const fromBase32 = (text: string): Buffer => {
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const char of text.replace(/=+$/, '')) {
        value = (value << 5) | BASE32.indexOf(char)
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(out)
}
const TOTP_STEP_MS = 30_000
export const stepNow = (): number => Math.floor(Date.now() / TOTP_STEP_MS)

/** The code of one 30 s step. */
export function totpAt(secret: string, step: number): string {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const digest = createHmac('sha1', fromBase32(secret)).update(counter).digest()
    const at = (digest[digest.length - 1] ?? 0) & 0x0f
    const binary =
        (((digest[at] ?? 0) & 0x7f) << 24) |
        ((digest[at + 1] ?? 0) << 16) |
        ((digest[at + 2] ?? 0) << 8) |
        (digest[at + 3] ?? 0)
    return String(binary % 1_000_000).padStart(6, '0')
}
