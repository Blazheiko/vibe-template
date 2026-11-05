import aiConfig from '#config/ai.js'
import { aiRequestSignal } from '#app/services/ai/ai-request-signal.js'
import { buildFinalTextPrompt } from '#app/services/ai/types.js'
import type {
    ITextAdapter,
    TextStreamOptions,
    TextUsageCompleteHandler,
    ReportedUsage,
} from '#app/services/ai/types.js'
import { UNKNOWN_USAGE } from '#app/services/ai/types.js'
import logger from '#logger'

interface MinimalFetchResponse {
    ok: boolean
    status: number
    text: () => Promise<string>
    body: ReadableStream<Uint8Array> | null
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: ChatToolCall[]
    tool_call_id?: string
}

interface ChatToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

interface StreamResult {
    text: string
    toolCalls: ChatToolCall[]
    usage: ReportedUsage | null
}

const cfg = aiConfig.providers.openai

function parseUsage(value: unknown): ReportedUsage | null {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    // feat-136 (L6): a usage object without token counts is no usage, not 0 real tokens.
    if (
        typeof record['prompt_tokens'] !== 'number' ||
        typeof record['completion_tokens'] !== 'number'
    ) {
        return null
    }
    const promptTokens = record['prompt_tokens']
    const completionTokens = record['completion_tokens']
    const totalTokens =
        typeof record['total_tokens'] === 'number'
            ? record['total_tokens']
            : promptTokens + completionTokens
    return { promptTokens, completionTokens, totalTokens }
}

function mergeUsage(
    first: ReportedUsage | null,
    second: ReportedUsage | null,
): ReportedUsage | null {
    if (first === null) return second
    if (second === null) return first
    return {
        promptTokens: first.promptTokens + second.promptTokens,
        completionTokens: first.completionTokens + second.completionTokens,
        totalTokens: first.totalTokens + second.totalTokens,
    }
}

function parseToolArguments(raw: string): unknown {
    if (raw.trim().length === 0) return {}
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return raw
    }
}

function shouldSendTemperature(modelName: string): boolean {
    const normalized = modelName.toLowerCase()
    if (normalized === 'gpt-5.4-mini') return true
    if (normalized.startsWith('gpt-5')) return false
    if (/^o\d/.test(normalized) || normalized.startsWith('o4-')) return false
    return true
}

function buildSamplingParams(
    modelName: string,
    temperature: number | undefined,
    maxOutputTokens: number | undefined,
): Record<string, unknown> {
    return {
        ...(shouldSendTemperature(modelName) ? { temperature: temperature ?? 0.3 } : {}),
        max_completion_tokens: maxOutputTokens ?? 2000,
    }
}

async function* streamChatCompletion(
    payload: Record<string, unknown>,
    signal: AbortSignal,
): AsyncGenerator<string, StreamResult, undefined> {
    const response = (await fetch(cfg.chatApiUrl, {
        method: 'POST',
        signal,
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    })) as unknown as MinimalFetchResponse

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenAI error ${String(response.status)}: ${errorText.slice(0, 300)}`)
    }

    if (response.body === null) {
        throw new Error('OpenAI response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const toolCallsByIndex = new Map<number, ChatToolCall>()
    let fullText = ''
    let buffer = ''
    let usage: ReportedUsage | null = null

    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed === '' || trimmed === 'data: [DONE]') continue
                if (!trimmed.startsWith('data: ')) continue

                let parsed: unknown
                try {
                    parsed = JSON.parse(trimmed.slice(6)) as unknown
                } catch {
                    continue
                }
                if (typeof parsed !== 'object' || parsed === null) continue

                const parsedRecord = parsed as Record<string, unknown>
                usage = mergeUsage(usage, parseUsage(parsedRecord['usage']))
                const choices = parsedRecord['choices']
                if (!Array.isArray(choices) || choices.length === 0) continue
                const choice = choices[0] as Record<string, unknown>
                const delta = choice['delta']
                if (typeof delta !== 'object' || delta === null) continue
                const deltaRecord = delta as Record<string, unknown>

                const content = deltaRecord['content']
                if (typeof content === 'string' && content.length > 0) {
                    fullText += content
                    yield content
                }

                const toolCalls = deltaRecord['tool_calls']
                if (!Array.isArray(toolCalls)) continue
                for (const rawToolCall of toolCalls) {
                    if (typeof rawToolCall !== 'object' || rawToolCall === null) continue
                    const toolCallDelta = rawToolCall as Record<string, unknown>
                    const index =
                        typeof toolCallDelta['index'] === 'number' ? toolCallDelta['index'] : 0
                    const existing = toolCallsByIndex.get(index) ?? {
                        id: '',
                        type: 'function' as const,
                        function: { name: '', arguments: '' },
                    }
                    const id = toolCallDelta['id']
                    if (typeof id === 'string') existing.id = id

                    const fn = toolCallDelta['function']
                    if (typeof fn === 'object' && fn !== null) {
                        const fnRecord = fn as Record<string, unknown>
                        const name = fnRecord['name']
                        if (typeof name === 'string') existing.function.name += name
                        const args = fnRecord['arguments']
                        if (typeof args === 'string') existing.function.arguments += args
                    }
                    toolCallsByIndex.set(index, existing)
                }
            }
        }
    } finally {
        reader.releaseLock()
    }

    return {
        text: fullText,
        toolCalls: [...toolCallsByIndex.values()].filter(
            (call) => call.id !== '' && call.function.name !== '',
        ),
        usage,
    }
}

export const openaiTextAdapter: ITextAdapter = {
    isConfigured(): boolean {
        return cfg.apiKey !== ''
    },

    get model(): string {
        return cfg.chatModel
    },

    async *streamText(
        opts: TextStreamOptions,
        onComplete?: TextUsageCompleteHandler,
    ): AsyncGenerator<string, string, undefined> {
        // One deadline for the whole call, tool round-trip included.
        const signal = aiRequestSignal(opts.signal)
        if (cfg.apiKey === '') {
            throw new Error('OpenAI is not configured')
        }

        const modelName = opts.modelOverride ?? cfg.chatModel
        const finalPrompt = buildFinalTextPrompt(opts)
        const messages: ChatMessage[] = [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.userPrompt },
        ]
        const tools =
            opts.toolCallHandler === undefined
                ? undefined
                : Object.entries(opts.toolCallHandler.tools).map(([name, def]) => ({
                      type: 'function',
                      function: {
                          name,
                          description: def.description,
                          parameters: def.parametersSchema,
                      },
                  }))

        const basePayload = {
            model: modelName,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...buildSamplingParams(modelName, opts.temperature, opts.maxOutputTokens),
            ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
        }

        const first = yield* streamChatCompletion(basePayload, signal)
        let fullText = first.text
        let usage = first.usage
        const toolRound = opts.toolCallHandler !== undefined && first.toolCalls.length > 0
        // Known before the tool round-trip: a call cut off in the second round keeps it (feat-118).
        // feat-136 (L7): with a tool round it is only part of the call.
        if (usage !== null) opts.onUsageReported?.(usage, { partial: toolRound })

        if (opts.toolCallHandler !== undefined && toolRound) {
            logger.info(
                { tools: first.toolCalls.map((call) => call.function.name) },
                'OpenAI adapter: executing tool calls',
            )
            messages.push({
                role: 'assistant',
                content: first.text.length > 0 ? first.text : null,
                tool_calls: first.toolCalls,
            })
            for (const call of first.toolCalls) {
                const result = await opts.toolCallHandler.onCall(
                    call.function.name,
                    parseToolArguments(call.function.arguments),
                )
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: result,
                })
            }

            const second = yield* streamChatCompletion(
                {
                    model: modelName,
                    messages,
                    stream: true,
                    stream_options: { include_usage: true },
                    ...buildSamplingParams(modelName, opts.temperature, opts.maxOutputTokens),
                },
                signal,
            )
            fullText += second.text
            // feat-136 (L7): without the second round's usage the call's usage is unknown; the
            // first round stays what it was reported as (partial).
            usage = second.usage === null ? null : mergeUsage(usage, second.usage)
            if (usage !== null) opts.onUsageReported?.(usage, { partial: false })
        }

        if (usage === null) {
            logger.warn({ model: modelName }, 'OpenAI adapter: provider reported no usage')
        }
        if (onComplete !== undefined) {
            try {
                onComplete(usage ?? UNKNOWN_USAGE, modelName, finalPrompt)
            } catch (err) {
                logger.warn({ err }, 'OpenAI adapter: usage callback failed')
            }
        }

        return fullText
    },
}
