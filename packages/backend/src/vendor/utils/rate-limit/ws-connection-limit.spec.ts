import { beforeEach, describe, expect, it } from 'vitest'

import {
    __resetWsConnectionLimitForTests,
    acquireWsConnection,
    releaseWsConnection,
    wsConnectionCounts,
    type WsConnectionSlot,
} from './ws-connection-limit.js'

const LIMITS = { maxConnectionsPerUser: 3, maxConnectionsPerIp: 5 }

const acquire = (userId: string, ip: string, limits = LIMITS): WsConnectionSlot => {
    const admission = acquireWsConnection(userId, ip, limits)
    if (admission.kind !== 'ok') throw new Error(`refused by ${admission.by}`)
    return admission.slot
}

beforeEach(() => {
    __resetWsConnectionLimitForTests()
})

describe('acquireWsConnection', () => {
    it('refuses the connection over the user limit and takes no place for it', () => {
        for (let n = 0; n < 3; n += 1) acquire('1', `10.0.0.${String(n)}`)

        expect(acquireWsConnection('1', '10.0.0.9', LIMITS)).toEqual({
            kind: 'limited',
            by: 'user',
        })
        expect(wsConnectionCounts('1', '10.0.0.9')).toEqual({ user: 3, ip: 0 })
    })

    it('refuses the connection over the address limit, whoever the user is', () => {
        for (let n = 0; n < 5; n += 1) acquire(String(n), '10.0.0.1')

        expect(acquireWsConnection('99', '10.0.0.1', LIMITS)).toEqual({
            kind: 'limited',
            by: 'ip',
        })
        expect(wsConnectionCounts('99', '10.0.0.1')).toEqual({ user: 0, ip: 5 })
    })

    it('does not count one user against another, or one address against another', () => {
        for (let n = 0; n < 3; n += 1) acquire('1', '10.0.0.1')

        expect(acquireWsConnection('2', '10.0.0.1', LIMITS).kind).toBe('ok')
        expect(acquireWsConnection('1', '10.0.0.2', LIMITS)).toEqual({
            kind: 'limited',
            by: 'user',
        })
    })

    it('gives the place back when a connection closes', () => {
        const slots = [acquire('1', '10.0.0.1'), acquire('1', '10.0.0.1'), acquire('1', '10.0.0.1')]
        expect(acquireWsConnection('1', '10.0.0.1', LIMITS).kind).toBe('limited')

        const first = slots[0]
        if (first === undefined) throw new Error('no slot')
        releaseWsConnection(first)

        expect(wsConnectionCounts('1', '10.0.0.1')).toEqual({ user: 2, ip: 2 })
        expect(acquireWsConnection('1', '10.0.0.1', LIMITS).kind).toBe('ok')
    })

    it('forgets a user and an address with no connection left', () => {
        const slot = acquire('1', '10.0.0.1')
        releaseWsConnection(slot)
        // A release with nothing to release must not go below zero.
        releaseWsConnection(slot)

        expect(wsConnectionCounts('1', '10.0.0.1')).toEqual({ user: 0, ip: 0 })
        for (let n = 0; n < 3; n += 1) acquire('1', '10.0.0.1')
        expect(acquireWsConnection('1', '10.0.0.1', LIMITS).kind).toBe('limited')
    })

    it('0 switches a limit off', () => {
        const off = { maxConnectionsPerUser: 0, maxConnectionsPerIp: 0 }
        for (let n = 0; n < 200; n += 1) {
            expect(acquireWsConnection('1', '10.0.0.1', off).kind).toBe('ok')
        }
    })
})
