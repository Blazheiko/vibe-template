import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
    vi.resetModules()
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key]
    }
    Object.assign(process.env, ORIGINAL_ENV)
})

const load = async () => (await import('./ai.js')).default

describe('AI config (code-issues items 50, 51)', () => {
    it.each([['openai'], ['xai'], ['mistral']])('accepts AI_TEXT_DRIVER=%s', async (driver) => {
        process.env['AI_TEXT_DRIVER'] = driver
        const config = await load()
        expect(config.drivers.text).toBe(driver)
        expect(config.configError).toBeNull()
    })

    it('defaults to openai and a 60 s timeout', async () => {
        delete process.env['AI_TEXT_DRIVER']
        delete process.env['AI_REQUEST_TIMEOUT_MS']
        const config = await load()
        expect(config.drivers.text).toBe('openai')
        expect(config.requestTimeoutMs).toBe(60_000)
        expect(config.configError).toBeNull()
    })

    it('reports an unknown AI_TEXT_DRIVER instead of falling back to Mistral', async () => {
        process.env['AI_TEXT_DRIVER'] = 'openia'
        const config = await load()
        expect(config.configError).toContain('AI_TEXT_DRIVER must be one of openai, xai, mistral')
    })

    it.each([['abc'], ['999'], ['-5'], ['1.5']])(
        'reports AI_REQUEST_TIMEOUT_MS=%s',
        async (value) => {
            process.env['AI_REQUEST_TIMEOUT_MS'] = value
            const config = await load()
            expect(config.configError).toContain('AI_REQUEST_TIMEOUT_MS')
        },
    )

    it('reads AI_REQUEST_TIMEOUT_MS', async () => {
        process.env['AI_REQUEST_TIMEOUT_MS'] = '15000'
        expect((await load()).requestTimeoutMs).toBe(15_000)
    })
})

describe('embedding dimensions (code-issues item 54)', () => {
    it('accepts the column size 1536', async () => {
        process.env['OPENAI_EMBEDDING_DIMENSIONS'] = '1536'
        expect((await load()).configError).toBeNull()
    })

    it.each([['3072'], ['abc']])(
        'reports OPENAI_EMBEDDING_DIMENSIONS=%s that does not match the column',
        async (value) => {
            process.env['OPENAI_EMBEDDING_DIMENSIONS'] = value
            expect((await load()).configError).toContain('OPENAI_EMBEDDING_DIMENSIONS')
        },
    )
})

describe('prompt cache TTL (code-issues item 43)', () => {
    it('defaults to 60 s and reads PROMPT_CACHE_TTL_MS', async () => {
        delete process.env['PROMPT_CACHE_TTL_MS']
        expect((await load()).promptCacheTtlMs).toBe(60_000)
        vi.resetModules()
        process.env['PROMPT_CACHE_TTL_MS'] = '5000'
        expect((await load()).promptCacheTtlMs).toBe(5000)
    })

    it('reports an invalid PROMPT_CACHE_TTL_MS', async () => {
        process.env['PROMPT_CACHE_TTL_MS'] = '-1'
        expect((await load()).configError).toContain('PROMPT_CACHE_TTL_MS')
    })
})

describe('validateRuntimeConfig and AI config', () => {
    it('stops the start on an unknown AI_TEXT_DRIVER', async () => {
        process.env['AI_TEXT_DRIVER'] = 'foo'
        const { validateRuntimeConfig } = await import('#app/start/validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(/Invalid AI configuration: AI_TEXT_DRIVER/)
    })

    it('stops the start on an invalid Support AI setting', async () => {
        process.env['SUPPORT_DEFAULT_LANGUAGE'] = 'klingon'
        const { validateRuntimeConfig } = await import('#app/start/validate-runtime-config.js')
        expect(() => {
            validateRuntimeConfig()
        }).toThrow(/Invalid Support AI configuration: SUPPORT_DEFAULT_LANGUAGE/)
    })
})

describe('AI config: the daily token budget (feat-063, D2)', () => {
    it('defaults to 200000 tokens a day and an 8000-token prompt allowance', async () => {
        delete process.env['AI_SUPPORT_DAILY_TOKEN_BUDGET']
        delete process.env['AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS']
        const config = await load()
        expect(config.supportDailyTokenBudget).toBe(200_000)
        expect(config.supportPromptAllowanceTokens).toBe(8_000)
        expect(config.configError).toBeNull()
    })

    it('reads both values, and 0 switches the budget off', async () => {
        process.env['AI_SUPPORT_DAILY_TOKEN_BUDGET'] = '0'
        process.env['AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS'] = '12000'
        const config = await load()
        expect(config.supportDailyTokenBudget).toBe(0)
        expect(config.supportPromptAllowanceTokens).toBe(12_000)
        expect(config.configError).toBeNull()
    })

    it.each([
        ['AI_SUPPORT_DAILY_TOKEN_BUDGET', '-1'],
        ['AI_SUPPORT_DAILY_TOKEN_BUDGET', '1e5'],
        ['AI_SUPPORT_DAILY_TOKEN_BUDGET', '0x10'],
        ['AI_SUPPORT_DAILY_TOKEN_BUDGET', '1.5'],
        ['AI_SUPPORT_DAILY_TOKEN_BUDGET', 'lots'],
        ['AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS', '-5'],
        ['AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS', '8k'],
    ])('reports %s=%s', async (name, value) => {
        process.env[name] = value
        const config = await load()
        expect(config.configError).toContain(`${name} must be an integer >= 0`)
    })
})

describe('AI config: what the usage log keeps of a prompt (feat-065)', () => {
    it('keeps no prompt text by default, and 30 days when it is switched on', async () => {
        delete process.env['AI_USAGE_STORE_PROMPTS']
        delete process.env['AI_USAGE_PROMPT_RETENTION_DAYS']
        const config = await load()
        expect(config.usage).toEqual({ storePrompts: false, promptRetentionDays: 30 })
        expect(config.configError).toBeNull()
    })

    it.each([
        ['true', true],
        ['false', false],
        [' TRUE ', true],
        ['yes', true],
        ['1', true],
        ['on', true],
        ['no', false],
        ['0', false],
        ['off', false],
    ])(
        'reads AI_USAGE_STORE_PROMPTS=%s (the one boolean contract, feat-082)',
        async (value, expected) => {
            process.env['AI_USAGE_STORE_PROMPTS'] = value
            expect((await load()).usage.storePrompts).toBe(expected)
        },
    )

    it.each([['ture'], ['enabled'], ['2'], ['y']])(
        'rejects AI_USAGE_STORE_PROMPTS=%s instead of guessing (a typo must not start keeping prompts)',
        async (value) => {
            process.env['AI_USAGE_STORE_PROMPTS'] = value
            expect((await load()).configError).toContain(
                'AI_USAGE_STORE_PROMPTS must be one of true, 1, yes, on, false, 0, no, off',
            )
        },
    )

    it('reads the retention', async () => {
        process.env['AI_USAGE_PROMPT_RETENTION_DAYS'] = '7'
        expect((await load()).usage.promptRetentionDays).toBe(7)
    })

    it.each([['0'], ['-3'], ['1.5'], ['1e2'], ['week']])(
        'rejects AI_USAGE_PROMPT_RETENTION_DAYS=%s',
        async (value) => {
            process.env['AI_USAGE_PROMPT_RETENTION_DAYS'] = value
            expect((await load()).configError).toContain('AI_USAGE_PROMPT_RETENTION_DAYS')
        },
    )
})
