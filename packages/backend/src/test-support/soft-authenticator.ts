import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { AuthenticationResponse, RegistrationResponse } from 'shared/schemas'

// feat-246 (tasks P2–P4): a software WebAuthn authenticator for the tests. It makes real answers
// (ES256 key, CBOR attestation object `none`, authenticator data, ECDSA signature) so the tests run
// the same verification the server runs for a browser. Every field the server checks can be
// changed per call: the origin, the RP ID, user verification, the counter, the user handle.

export interface CeremonyOptions {
    challenge: string
    rpId: string
    origin: string
    /** User verification (UV flag); the server requires it. */
    userVerified?: boolean
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest()
const b64url = (data: Buffer): string => data.toString('base64url')

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

export class SoftAuthenticator {
    readonly credentialId: Buffer
    private readonly privateKey: KeyObject
    private readonly publicKey: KeyObject
    /** The next signature counter; 0 stays 0 (an authenticator without a counter). */
    counter: number
    /** The WebAuthn user handle the authenticator stored at registration. */
    userHandle: Buffer | null = null

    constructor(options: { counter?: number } = {}) {
        const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        this.privateKey = pair.privateKey
        this.publicKey = pair.publicKey
        this.credentialId = randomBytes(16)
        this.counter = options.counter ?? 0
    }

    private coseKey(): Uint8Array {
        const jwk = this.publicKey.export({ format: 'jwk' })
        const map = new Map<number, number | Uint8Array>([
            [1, 2], // kty: EC2
            [3, -7], // alg: ES256
            [-1, 1], // crv: P-256
            [-2, new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url'))],
            [-3, new Uint8Array(Buffer.from(jwk.y ?? '', 'base64url'))],
        ])
        return isoCBOR.encode(map)
    }

    private authData(rpId: string, flags: number, attested: boolean): Buffer {
        const counter = Buffer.alloc(4)
        counter.writeUInt32BE(this.counter)
        const parts = [sha256(rpId), Buffer.from([flags]), counter]
        if (attested) {
            const length = Buffer.alloc(2)
            length.writeUInt16BE(this.credentialId.length)
            parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.coseKey()))
        }
        return Buffer.concat(parts)
    }

    private clientData(type: string, options: CeremonyOptions): Buffer {
        return Buffer.from(
            JSON.stringify({
                type,
                challenge: options.challenge,
                origin: options.origin,
                crossOrigin: false,
            }),
        )
    }

    /** The answer to registration options; remembers the user handle of the options. */
    register(options: CeremonyOptions & { userHandle: string }): RegistrationResponse {
        this.userHandle = Buffer.from(options.userHandle, 'base64url')
        const flags = UP | AT | BE | BS | (options.userVerified === false ? 0 : UV)
        const authData = this.authData(options.rpId, flags, true)
        const attestationObject = isoCBOR.encode(
            new Map<string, unknown>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', new Uint8Array(authData)],
            ]) as never,
        )
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(this.clientData('webauthn.create', options)),
                attestationObject: b64url(Buffer.from(attestationObject)),
                transports: ['internal', 'hybrid'],
            },
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
        }
    }

    /**
     * A signature for authentication options. The counter grows by one first unless it is 0;
     * `userHandle: null` leaves it out of the answer, a Buffer answers that handle instead.
     */
    authenticate(
        options: CeremonyOptions & { userHandle?: Buffer | null; counter?: number },
    ): AuthenticationResponse {
        if (options.counter !== undefined) this.counter = options.counter
        else if (this.counter > 0) this.counter += 1
        const flags = UP | BE | BS | (options.userVerified === false ? 0 : UV)
        const authData = this.authData(options.rpId, flags, false)
        const clientDataJSON = this.clientData('webauthn.get', options)
        const signature = sign(
            'sha256',
            Buffer.concat([authData, sha256(clientDataJSON)]),
            this.privateKey,
        )
        const handle = options.userHandle === undefined ? this.userHandle : options.userHandle
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(clientDataJSON),
                authenticatorData: b64url(authData),
                signature: b64url(signature),
                ...(handle !== null ? { userHandle: b64url(handle) } : {}),
            },
            clientExtensionResults: {},
            authenticatorAttachment: 'platform',
        }
    }
}
