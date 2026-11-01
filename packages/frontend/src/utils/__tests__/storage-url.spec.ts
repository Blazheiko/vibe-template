import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStorageFileUrl, type StorageConfig } from '../storage-url'

// feat-076 (J): moved out of the state store; the cases were checked against the old
// `stateStore.getStorageFileUrl` (55 combinations gave the same answers).

const none: StorageConfig = {
    cdnUrl: '',
    s3Prefix: '',
    s3StaticDataPrefix: '',
    s3DynamicDataPrefix: '',
}
const cdn: StorageConfig = {
    cdnUrl: 'https://cdn.example.com/',
    s3Prefix: 'app',
    s3StaticDataPrefix: 's',
    s3DynamicDataPrefix: 'dyn',
}
const sloppy: StorageConfig = {
    cdnUrl: ' https://cdn.example.com ',
    s3Prefix: '/app/',
    s3StaticDataPrefix: '',
    s3DynamicDataPrefix: '/dyn/',
}

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('getStorageFileUrl', () => {
    it('leaves an absolute address alone, whatever the configuration', () => {
        expect(getStorageFileUrl(cdn, 'https://other.example/x.png')).toBe(
            'https://other.example/x.png',
        )
        expect(getStorageFileUrl(none, 'http://other.example/x.png')).toBe(
            'http://other.example/x.png',
        )
    })

    it('puts the dynamic-data prefix and then the root prefix in front, each once', () => {
        expect(getStorageFileUrl(cdn, 'avatars/1.png')).toBe(
            'https://cdn.example.com/app/dyn/avatars/1.png',
        )
        expect(getStorageFileUrl(cdn, 'dyn/avatars/1.png')).toBe(
            'https://cdn.example.com/app/dyn/avatars/1.png',
        )
        // The dynamic prefix is checked first, on the source as given: a source that already starts
        // with the root prefix but not the dynamic one gets both again. As it always did.
        expect(getStorageFileUrl(cdn, 'app/dyn/x.png')).toBe(
            'https://cdn.example.com/app/dyn/app/dyn/x.png',
        )
    })

    it('recognises a prefix only as a whole path segment', () => {
        expect(getStorageFileUrl(cdn, 'dynamic/x')).toBe(
            'https://cdn.example.com/app/dyn/dynamic/x',
        )
        expect(getStorageFileUrl(cdn, 'appx/y')).toBe('https://cdn.example.com/app/dyn/appx/y')
    })

    it('trims the source and the slashes around the prefixes and around the CDN address', () => {
        expect(getStorageFileUrl(sloppy, '  /avatars/1.png ')).toBe(
            'https://cdn.example.com/app/dyn/avatars/1.png',
        )
    })

    it('uses the API storage route when there is no CDN, at the base from the environment', () => {
        vi.stubEnv('VITE_BASE_URL', 'https://api.example.com/')
        expect(getStorageFileUrl({ ...none, s3Prefix: 'app' }, 'x.png')).toBe(
            'https://api.example.com/api/storage/app/x.png',
        )
        vi.stubEnv('VITE_BASE_URL', '')
        expect(getStorageFileUrl(none, 'x.png')).toBe('/api/storage/x.png')
        expect(getStorageFileUrl({ ...none, s3DynamicDataPrefix: 'dyn' }, 'x.png')).toBe(
            '/api/storage/dyn/x.png',
        )
    })
})
