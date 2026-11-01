import { describe, expect, it } from 'vitest'
import { Result } from 'better-result'
import { toInternalError, tryInternal } from './result-helpers.js'

describe('result helpers', () => {
    it('maps thrown errors to internal app errors', async () => {
        const result = await tryInternal(async () => {
            throw new Error('boom')
        }, 'Hidden')

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error._tag).toBe('Internal')
            if (result.error._tag === 'Internal') {
                expect(result.error.publicMessage).toBe('Hidden')
                expect(result.error.cause).toBeInstanceOf(Error)
            }
        }
    })

    it('creates internal errors from arbitrary causes', () => {
        expect(toInternalError('boom', 'Hidden')).toEqual({
            _tag: 'Internal',
            publicMessage: 'Hidden',
            cause: 'boom',
        })
    })

    // The rate-limit Redis client (a second connection) throws plain ioredis errors, not
    // RedisUnavailableError; an outage seen through it must also be a 503, not a 500.
    it.each(['Command timed out', 'Connection is closed.', "Stream isn't writeable"])(
        'maps the ioredis outage "%s" to service unavailable',
        async (message) => {
            const result = await tryInternal(async () => {
                throw new Error(message)
            }, 'Hidden')

            expect(Result.isError(result) && result.error._tag).toBe('ServiceUnavailable')
        },
    )

    it('keeps a Redis reply error (a bug) internal', () => {
        const replyError = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' })

        expect(toInternalError(replyError, 'Hidden')._tag).toBe('Internal')
    })
})
