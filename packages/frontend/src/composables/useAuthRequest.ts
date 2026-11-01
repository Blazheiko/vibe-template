import type { Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'

/**
 * What every auth form does around a request: show it is loading, run it, and when it throws
 * (as opposed to answering with an error) say "server error" and log what happened. The form
 * says what the request is (`label` names it in the log) and where the loading flag and the
 * error live.
 */
export function useAuthRequest() {
    const { t } = useI18n()

    async function runAuthRequest(
        loading: Ref<boolean>,
        error: Ref<string>,
        label: string,
        work: () => Promise<void>,
    ): Promise<void> {
        loading.value = true
        try {
            await work()
        } catch (err: unknown) {
            console.error(`${label} failed:`, err)
            error.value = t('auth.errorServer')
        } finally {
            loading.value = false
        }
    }

    /** The message to show when a response is an error (or carries one); null when it is not. */
    function failureMessage(data: unknown, error: { message?: string } | null): string | null {
        if (error === null && !hasResponseError(data)) return null
        return getResponseMessage(data, error?.message ?? t('auth.errorServer'))
    }

    return { runAuthRequest, failureMessage }
}
