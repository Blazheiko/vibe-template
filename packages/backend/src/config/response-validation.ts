import { env } from 'node:process'
import appConfig from '#config/app.js'

// Reaction to a broken response contract (docs/plan/archive/strip-response-fields-plan.md §4.2).
// A schema mismatch is a 500 in both modes; undeclared keys are a 500 in strict and are
// stripped with a warn in log. The schema runs on every response: there is no off mode.
export const RESPONSE_VALIDATION_CONTRACT_MODES = ['strict', 'log'] as const
export type ResponseValidationMode = (typeof RESPONSE_VALIDATION_CONTRACT_MODES)[number]

export interface ResponseValidationConfig {
    mode: ResponseValidationMode
    configError: string | null
}

const isMode = (value: string): value is ResponseValidationMode =>
    (RESPONSE_VALIDATION_CONTRACT_MODES as readonly string[]).includes(value)

const readConfig = (): ResponseValidationConfig => {
    const fallback: ResponseValidationMode = appConfig.isProductionLike ? 'log' : 'strict'
    const raw = (env['RESPONSE_VALIDATION_CONTRACT'] ?? '').trim().toLowerCase()
    if (raw === '') return { mode: fallback, configError: null }
    if (isMode(raw)) return { mode: raw, configError: null }
    return {
        mode: fallback,
        configError: `RESPONSE_VALIDATION_CONTRACT must be one of ${RESPONSE_VALIDATION_CONTRACT_MODES.join(', ')}, got "${raw}"`,
    }
}

export default Object.freeze(readConfig())
