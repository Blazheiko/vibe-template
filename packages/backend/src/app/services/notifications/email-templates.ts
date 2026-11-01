// Email clients do not support app CSS variables reliably, so this palette stays inline on purpose.
export const EMAIL_BRAND = {
    accent: '#A8627A',
    accentHover: '#96516A',
    canvas: '#FAF0F3',
    surface: '#FFFFFF',
    textPrimary: '#2C3440',
    textSecondary: '#5E6977',
    border: '#D8DDE6',
    accentSoft: '#F6E8EE',
    accentLine: '#E7C8D3',
} as const

export function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export interface RenderedEmail {
    subject: string
    text: string
    html: string
}

/** What the mail asks the reader to open. */
export type EmailAction =
    /** A button, and the same address again in a box for readers whose client drops buttons. */
    | { kind: 'button'; label: string; url: string }
    /** The address alone, as a link. */
    | { kind: 'link'; url: string }

export interface BrandedEmail {
    subject: string
    /** Hidden line some clients show next to the subject; none when absent. */
    preheader?: string
    /** Small caps line above the title. */
    eyebrow: string
    title: string
    /** Addressee: ", <name>" follows the greeting, nothing for a blank name. */
    name: string
    /** The paragraph under the greeting. */
    intro: string
    action: EmailAction
    /** Small print at the bottom. */
    footer: string
    /** The plain-text body after the greeting: lines, the address included. */
    textLines: readonly string[]
}

/**
 * The transactional mail every auth flow sends (password reset, e-mail verification, e-mail
 * linking): one layout, the words and the action vary. `preheader`, `eyebrow`, `title`, `intro`,
 * the button label and `footer` are the caller's own fixed words and go in as they are; the name
 * and the address come from outside and are escaped here.
 */
export function renderBrandedEmail(mail: BrandedEmail): RenderedEmail {
    const trimmedName = mail.name.trim()
    const safeName = trimmedName === '' ? '' : `, ${trimmedName}`
    const escapedGreeting = trimmedName === '' ? '' : `, ${escapeHtml(trimmedName)}`
    const escapedUrl = escapeHtml(mail.action.url)

    const text = [`Hello${safeName}.`, '', ...mail.textLines].join('\n')

    const preheader =
        mail.preheader === undefined
            ? ''
            : `    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      ${mail.preheader}
    </div>
`

    const action =
        mail.action.kind === 'button'
            ? `                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
                        <tr>
                          <td align="center" bgcolor="${EMAIL_BRAND.accent}" style="border-radius:16px;box-shadow:0 14px 26px rgba(168,98,122,0.24);">
                            <a
                              href="${escapedUrl}"
                              style="display:inline-block;padding:17px 28px;font-size:17px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:16px;background:${EMAIL_BRAND.accent};"
                            >
                              ${mail.action.label}
                            </a>
                          </td>
                        </tr>
                      </table>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;border-collapse:separate;">
                        <tr>
                          <td style="padding:18px 20px;border-radius:18px;background:${EMAIL_BRAND.accentSoft};border:1px solid ${EMAIL_BRAND.accentLine};">
                            <div style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${EMAIL_BRAND.accent};">
                              Alternative link
                            </div>
                            <div style="font-size:15px;line-height:1.65;color:${EMAIL_BRAND.textSecondary};word-break:break-word;">
                              If the button does not work, open this link:<br />
                              <a href="${escapedUrl}" style="color:${EMAIL_BRAND.accent};text-decoration:underline;">
                                ${escapedUrl}
                              </a>
                            </div>
                          </td>
                        </tr>
                      </table>
`
            : `                      <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:${EMAIL_BRAND.textSecondary};word-break:break-word;">
                        <a href="${escapedUrl}" style="color:${EMAIL_BRAND.accent};text-decoration:underline;">
                          ${escapedUrl}
                        </a>
                      </p>
`

    const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:${EMAIL_BRAND.canvas};font-family:Inter,Arial,sans-serif;color:${EMAIL_BRAND.textPrimary};">
${preheader}    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EMAIL_BRAND.canvas};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;">
            <tr>
              <td style="padding-bottom:16px;">
                <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:${EMAIL_BRAND.accentSoft};border:1px solid ${EMAIL_BRAND.accentLine};color:${EMAIL_BRAND.accent};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                  Vibe Template
                </div>
              </td>
            </tr>
            <tr>
              <td style="border-radius:28px;background:${EMAIL_BRAND.surface};border:1px solid ${EMAIL_BRAND.border};box-shadow:0 18px 48px rgba(44,52,64,0.08);overflow:hidden;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:40px 40px 24px;background:linear-gradient(180deg, rgba(168,98,122,0.16) 0%, rgba(168,98,122,0.05) 100%);border-bottom:1px solid ${EMAIL_BRAND.border};">
                      <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_BRAND.accent};margin-bottom:14px;">
                        ${mail.eyebrow}
                      </div>
                      <h1 style="margin:0;font-size:34px;line-height:1.12;font-weight:800;color:${EMAIL_BRAND.textPrimary};">
                        ${mail.title}
                      </h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px 40px 40px;">
                      <p style="margin:0 0 18px;font-size:18px;line-height:1.65;color:${EMAIL_BRAND.textPrimary};">
                        Hello${escapedGreeting}.
                      </p>
                      <p style="margin:0 0 28px;font-size:17px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        ${mail.intro}
                      </p>
${action}                      <div style="padding-top:20px;border-top:1px solid ${EMAIL_BRAND.border};font-size:14px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        ${mail.footer}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

    return { subject: mail.subject, text, html }
}
