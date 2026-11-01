import { describe, expect, it } from 'vitest'
import {
    arrayBufferToBase64,
    getBrowserInfo,
    getDeviceType,
    getOSInfo,
    isValidVapidKey,
    urlBase64ToUint8Array,
} from '../push-device'

// feat-076 (J): moved out of the state store with the answers it gave. What these say is stored by
// the server (browser_name, os_name, device_type), so the odd ones are pinned as they are.

const UA = {
    chromeWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    edgeWin:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    safariMac:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    chromeAndroid:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    safariIphone:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
}

describe('getDeviceType', () => {
    it('says mobile for phones and tablets, desktop for the rest', () => {
        expect(getDeviceType(UA.chromeAndroid)).toBe('mobile')
        expect(getDeviceType(UA.safariIphone)).toBe('mobile')
        expect(getDeviceType('Mozilla/5.0 (iPad; CPU OS 17_5)')).toBe('mobile')
        expect(getDeviceType(UA.chromeWin)).toBe('desktop')
        expect(getDeviceType('')).toBe('desktop')
    })
})

describe('getBrowserInfo', () => {
    it.each([
        [UA.chromeWin, 'Chrome', '126.0'],
        [UA.firefoxLinux, 'Firefox', '127.0'],
        [UA.safariMac, 'Safari', '17.5'],
        [UA.chromeAndroid, 'Chrome', '126.0'],
        ['curl/8.0', 'Unknown', 'Unknown'],
        ['', 'Unknown', 'Unknown'],
    ])('%s -> %s %s', (ua, name, version) => {
        expect(getBrowserInfo(ua)).toEqual({ name, version })
    })

    it('recognises Edge by "Edg", which also keeps it out of the Chrome branch', () => {
        expect(getBrowserInfo(UA.edgeWin)).toEqual({ name: 'Edge', version: '126.0' })
    })
})

describe('getOSInfo', () => {
    it.each([
        [UA.chromeWin, 'Windows', '10.0'],
        [UA.safariMac, 'macOS', '10.15.7'],
        [UA.firefoxLinux, 'Linux', 'Unknown'],
        ['', 'Unknown', 'Unknown'],
    ])('%s -> %s %s', (ua, name, version) => {
        expect(getOSInfo(ua)).toEqual({ name, version })
    })

    it('records an Android phone as Linux and an iPhone as macOS: their user agents contain "Linux" and "Mac OS X", which are tested first', () => {
        expect(getOSInfo(UA.chromeAndroid)).toEqual({ name: 'Linux', version: 'Unknown' })
        expect(getOSInfo(UA.safariIphone)).toEqual({ name: 'macOS', version: 'Unknown' })
    })
})

describe('keys', () => {
    it('urlBase64ToUint8Array reads base64url with or without padding', () => {
        expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3])
        expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255])
        expect([...urlBase64ToUint8Array('-_8=')]).toEqual([251, 255])
    })

    it('arrayBufferToBase64 writes base64, and nothing for no buffer', () => {
        expect(arrayBufferToBase64(new Uint8Array([1, 2, 3]).buffer)).toBe('AQID')
        expect(arrayBufferToBase64(null)).toBe('')
    })

    it('isValidVapidKey refuses unset, the placeholder and a short key', () => {
        expect(isValidVapidKey(null)).toBe(false)
        expect(isValidVapidKey('')).toBe(false)
        expect(isValidVapidKey('YOUR_VAPID_PUBLIC_KEY_HERE')).toBe(false)
        expect(isValidVapidKey('a'.repeat(79))).toBe(false)
        expect(isValidVapidKey('a'.repeat(80))).toBe(true)
    })
})
