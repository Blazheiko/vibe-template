import { randomBytes } from 'node:crypto'
import { hashPassword } from 'metautil'

let dummyHash: Promise<string> | undefined

// A login that finds no password to check (unknown identifier, OAuth-only account) checks the
// presented one against this hash, so it costs the same scrypt call as a wrong password and the
// answer time does not reveal whether the identifier is registered. Made by the same
// hashPassword as real hashes: validatePassword reads the scrypt parameters from the hash, so
// a hand-written constant would drift from them. The password is random and never stored.
export function getDummyPasswordHash(): Promise<string> {
    dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((error: unknown) => {
        dummyHash = undefined
        throw error
    })
    return dummyHash
}
