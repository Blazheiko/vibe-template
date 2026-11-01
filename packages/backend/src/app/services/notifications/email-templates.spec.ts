import { describe, expect, it } from 'vitest'
import { escapeHtml, renderBrandedEmail, type BrandedEmail } from './email-templates.js'

// feat-072 (H3): the three real mails are frozen byte for byte in
// auth/auth-email-templates.snapshot.spec.ts; this pins the layout function on its own.

const base: BrandedEmail = {
    subject: 'Subject',
    eyebrow: 'Eyebrow',
    title: 'Title',
    name: 'Jane',
    intro: 'Intro words.',
    action: { kind: 'button', label: 'Go', url: 'https://app.example.com/x?token=a&b=<c>' },
    footer: 'Footer words.',
    textLines: ['Open:', 'https://app.example.com/x?token=a&b=<c>'],
}

describe('escapeHtml', () => {
    it('escapes the five characters that matter in text and in quoted attributes', () => {
        expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
            '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
        )
    })

    it('escapes the ampersand first, so nothing is escaped twice', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;')
    })
})

describe('renderBrandedEmail', () => {
    it('keeps the subject, and builds the text from the greeting and the given lines', () => {
        const mail = renderBrandedEmail(base)
        expect(mail.subject).toBe('Subject')
        expect(mail.text).toBe('Hello, Jane.\n\nOpen:\nhttps://app.example.com/x?token=a&b=<c>')
    })

    it('greets a blank name without a comma, in text and in html', () => {
        const mail = renderBrandedEmail({ ...base, name: '   ' })
        expect(mail.text.startsWith('Hello.\n')).toBe(true)
        expect(mail.html).toContain('Hello.\n')
        expect(mail.html).not.toContain('Hello,')
    })

    it('escapes the name and the address in html, and leaves the text as it is', () => {
        const mail = renderBrandedEmail({ ...base, name: '<b>"J"</b>' })
        expect(mail.html).toContain('Hello, &lt;b&gt;&quot;J&quot;&lt;/b&gt;.')
        expect(mail.html).not.toContain('<b>"J"</b>')
        expect(mail.html).toContain('href="https://app.example.com/x?token=a&amp;b=&lt;c&gt;"')
        expect(mail.text).toContain('token=a&b=<c>')
    })

    it('a button action shows the button and the alternative link box', () => {
        const { html } = renderBrandedEmail(base)
        expect(html).toContain('>\n                              Go\n')
        expect(html).toContain('Alternative link')
        expect(html.match(/href="https:\/\/app\.example\.com/g)).toHaveLength(2)
    })

    it('a link action shows the address alone', () => {
        const { html } = renderBrandedEmail({
            ...base,
            action: { kind: 'link', url: 'https://app.example.com/x' },
        })
        expect(html).not.toContain('Alternative link')
        expect(html.match(/href="https:\/\/app\.example\.com/g)).toHaveLength(1)
    })

    it('has a hidden preheader only when one is given', () => {
        expect(renderBrandedEmail(base).html).not.toContain('display:none')
        expect(renderBrandedEmail({ ...base, preheader: 'Preview.' }).html).toContain(
            'display:none;max-height:0;overflow:hidden;opacity:0;">\n      Preview.',
        )
    })
})
