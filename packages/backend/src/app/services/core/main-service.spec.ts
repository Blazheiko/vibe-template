import { describe, expect, it, vi } from 'vitest'

vi.mock('#app/repositories/index.js', () => ({ userRepository: {} }))
vi.mock('#app/services/auth/generate-ws-token-service.js', () => ({ generateWsToken: vi.fn() }))
vi.mock('#app/services/communication/get-ws-url-service.js', () => ({ getWsUrl: vi.fn() }))
vi.mock('#app/services/user/account-service.js', () => ({ accountService: {} }))
vi.mock('#config/cookies.js', () => ({
    default: {
        default: { path: '/', httpOnly: true, secure: true, maxAge: 3600, sameSite: 'Lax' },
    },
}))

import { createResponseData } from '#vendor/utils/network/response-data.js'
import { mainService } from './main-service.js'

// feat-276: the demo route sets its header through setHeader, the documented way, so a second
// call replaces the value instead of sending the header twice.
describe('mainService.setHeaderAndCookie', () => {
    it('sets test-header once, however many times it runs', () => {
        const responseData = createResponseData()
        mainService.setHeaderAndCookie(responseData)
        mainService.setHeaderAndCookie(responseData)

        expect(responseData.headers).toEqual([{ name: 'test-header', value: 'test' }])
        expect([...responseData.cookies.keys()]).toEqual(['cookieTest1', 'cookieTest2'])
    })
})
