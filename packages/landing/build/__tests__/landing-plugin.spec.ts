import { describe, expect, it } from 'vitest'
import { isViteRequest } from '../landing-plugin'

describe('isViteRequest', () => {
    it.each([
        '/@vite/client',
        '/src/styles/main.css',
        '/node_modules/.vite/x.js',
        '/favicon.svg',
        '/og-image.png',
    ])('%s is left to Vite', (path) => {
        expect(isViteRequest(path)).toBe(true)
    })

    // nginx answers every unknown path with 404.html; the dev server renders the same page.
    it.each(['/missing.html', '/uk/missing.htm', '/nope', '/uk/nope/'])(
        '%s stays with the landing',
        (path) => {
            expect(isViteRequest(path)).toBe(false)
        },
    )
})
