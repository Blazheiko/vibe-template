import { Result } from 'better-result'
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer'
import logger from '#logger'
import mailConfig from '#config/mail.js'
import { badRequest, internalMessage, type AppResult } from '#app/services/shared/errors.js'

export interface EmailAddress {
    email: string
    name?: string
}

export interface EmailAttachment {
    filename: string
    content: Buffer | string
    contentType?: string
    cid?: string
}

export interface SendEmailInput {
    to: EmailAddress | string | readonly (EmailAddress | string)[]
    subject: string
    text?: string
    html?: string
    cc?: EmailAddress | string | readonly (EmailAddress | string)[]
    bcc?: EmailAddress | string | readonly (EmailAddress | string)[]
    replyTo?: EmailAddress | string | readonly (EmailAddress | string)[]
    from?: EmailAddress | string
    attachments?: readonly EmailAttachment[]
}

export interface SendEmailOutput {
    messageId: string
    accepted: string[]
    rejected: string[]
    response: string
}

type AddressInput = EmailAddress | string
type AddressListInput = AddressInput | readonly AddressInput[]
type TransportAddress = string
type MailTransporter = Transporter
interface SentMailInfo {
    messageId: string
    accepted: (string | { address: string })[]
    rejected: (string | { address: string })[]
    response: string
}

let transporter: MailTransporter | null = null

function isBlank(value: string | undefined): boolean {
    return value === undefined || value.trim() === ''
}

function normalizeAddress(input: AddressInput): TransportAddress | null {
    if (typeof input === 'string') {
        const email = input.trim()
        return email === '' ? null : email
    }

    const email = input.email.trim()
    if (email === '') return null

    const name = input.name?.trim()
    if (name === undefined || name === '') {
        return email
    }

    return `${name} <${email}>`
}

function normalizeAddressList(input: AddressListInput | undefined): TransportAddress[] {
    if (input === undefined) return []

    // Array.isArray narrows a readonly array to any[].
    const source = (Array.isArray(input) ? input : [input]) as readonly AddressInput[]
    return source
        .map((item) => normalizeAddress(item))
        .filter((item): item is TransportAddress => item !== null)
}

function getDefaultFromAddress(): TransportAddress {
    const defaultName = mailConfig.fromName.trim()
    if (defaultName === '') {
        return mailConfig.fromEmail.trim()
    }

    return `${defaultName} <${mailConfig.fromEmail.trim()}>`
}

function getConfigurationError(): string | null {
    if (!mailConfig.enabled) {
        return 'Email service is disabled'
    }

    if (isBlank(mailConfig.host)) {
        return 'SMTP_HOST is not configured'
    }

    if (isBlank(mailConfig.fromEmail)) {
        return 'SMTP_FROM_EMAIL is not configured'
    }

    const hasUser = !isBlank(mailConfig.user)
    const hasPassword = !isBlank(mailConfig.password)
    if (hasUser !== hasPassword) {
        return 'SMTP_USER and SMTP_PASSWORD must be configured together'
    }

    return null
}

function getTransporter(): MailTransporter {
    if (transporter !== null) {
        return transporter
    }

    transporter = nodemailer.createTransport({
        host: mailConfig.host,
        port: mailConfig.port,
        secure: mailConfig.secure,
        ...(mailConfig.requireTls ? { requireTLS: true } : {}),
        ...(mailConfig.ignoreTls ? { ignoreTLS: true } : {}),
        ...(!isBlank(mailConfig.user) && !isBlank(mailConfig.password)
            ? {
                  auth: {
                      user: mailConfig.user,
                      pass: mailConfig.password,
                  },
              }
            : {}),
    })

    return transporter
}

function normalizeResultAddresses(
    addresses: string | { address: string } | readonly (string | { address: string })[],
): string[] {
    const source = (Array.isArray(addresses) ? addresses : [addresses]) as readonly (
        string | { address: string }
    )[]
    return source.map((item) => (typeof item === 'string' ? item : item.address))
}

function sendMail(
    activeTransporter: MailTransporter,
    mailOptions: SendMailOptions,
): Promise<SentMailInfo> {
    const sendMailAsync = activeTransporter.sendMail.bind(activeTransporter) as (
        options: SendMailOptions,
    ) => Promise<SentMailInfo>

    return sendMailAsync(mailOptions)
}

export const emailService = {
    isConfigured(): boolean {
        return getConfigurationError() === null
    },

    async send(input: SendEmailInput): Promise<AppResult<SendEmailOutput>> {
        const configurationError = getConfigurationError()
        if (configurationError !== null) {
            logger.warn({ reason: configurationError }, 'Email service is not configured')
            return Result.err(internalMessage(configurationError))
        }

        if (isBlank(input.subject)) {
            return Result.err(badRequest('Email subject is required'))
        }

        if (isBlank(input.text) && isBlank(input.html)) {
            return Result.err(badRequest('Email text or html content is required'))
        }

        const to = normalizeAddressList(input.to)
        if (to.length === 0) {
            return Result.err(badRequest('At least one recipient is required'))
        }

        const cc = normalizeAddressList(input.cc)
        const bcc = normalizeAddressList(input.bcc)
        const replyTo = normalizeAddressList(input.replyTo)
        const from =
            input.from === undefined ? getDefaultFromAddress() : normalizeAddress(input.from)

        if (from === null) {
            return Result.err(badRequest('Sender email is required'))
        }

        // A transport failure (SMTP down, rejected login) throws (ADR 0004): the HTTP
        // caller answers 500, a background sender catches and logs it once.
        const mailOptions: SendMailOptions = {
            from,
            to,
            subject: input.subject.trim(),
            ...(isBlank(input.text) ? {} : { text: input.text }),
            ...(isBlank(input.html) ? {} : { html: input.html }),
            ...(cc.length === 0 ? {} : { cc }),
            ...(bcc.length === 0 ? {} : { bcc }),
            ...(replyTo.length === 0
                ? isBlank(mailConfig.replyTo)
                    ? {}
                    : { replyTo: mailConfig.replyTo.trim() }
                : { replyTo }),
            ...(input.attachments === undefined || input.attachments.length === 0
                ? {}
                : { attachments: [...input.attachments] }),
        }

        const info = await sendMail(getTransporter(), mailOptions)

        logger.info(
            {
                messageId: info.messageId,
                accepted: normalizeResultAddresses(info.accepted),
                rejected: normalizeResultAddresses(info.rejected),
                subject: input.subject.trim(),
            },
            'Email sent',
        )

        return Result.ok({
            messageId: info.messageId,
            accepted: normalizeResultAddresses(info.accepted),
            rejected: normalizeResultAddresses(info.rejected),
            response: info.response,
        })
    },
}
