<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import {
    AUDIT_ACTION_NAMES,
    AUDIT_GROUPS,
    AUDIT_TARGET_TYPES,
    type AuditAction,
    type AuditGroup,
    type AuditTargetType,
} from 'shared/audit'
import type { AdminAuditEventsQueryInput } from 'shared/schemas'
import type { AuditEvent } from 'shared/responses'
import { useDateFormat } from '@/composables/useDateFormat'
import { adminAuditEventsApi } from '@/utils/api'
import { getResponseMessage } from '@/utils/response-normalizer'

// feat-235 (Р10): the audit log for admins. The filters live in the query string of the page, so
// a reload, a link from the users or the knowledge base and the back button keep them.

interface Filters {
    /** Every `action` of the URL: `?action=a&action=b` asks for both. */
    action: string[]
    group: string
    actorUserId: string
    targetUserId: string
    targetType: string
    targetId: string
    requestId: string
    from: string
    to: string
}

/** The filters that take one value; `action` repeats. */
const SINGLE_KEYS = [
    'group',
    'actorUserId',
    'targetUserId',
    'targetType',
    'targetId',
    'requestId',
    'from',
    'to',
] as const satisfies readonly Exclude<keyof Filters, 'action'>[]

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { formatDateTime } = useDateFormat()

const emptyFilters = (): Filters => ({
    action: [],
    group: '',
    actorUserId: '',
    targetUserId: '',
    targetType: '',
    targetId: '',
    requestId: '',
    from: '',
    to: '',
})

const firstOf = (value: LocationQuery[string]): string => {
    const item = Array.isArray(value) ? value[0] : value
    return typeof item === 'string' ? item : ''
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTION_NAMES)

const allOf = (value: LocationQuery[string]): string[] =>
    (Array.isArray(value) ? value : [value]).filter(
        (item): item is string => typeof item === 'string' && KNOWN_ACTIONS.has(item),
    )

const filtersFromQuery = (query: LocationQuery): Filters => {
    const filters = emptyFilters()
    filters.action = allOf(query.action)
    for (const key of SINGLE_KEYS) filters[key] = firstOf(query[key])
    return filters
}

const form = ref<Filters>(filtersFromQuery(route.query))
const items = ref<AuditEvent[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const expanded = ref<string | null>(null)
const copied = ref<string | null>(null)

/** A `datetime-local` value (local time, no zone) as ISO 8601, or the ISO value as it is. */
const toIso = (value: string): string | undefined => {
    if (value === '') return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

const queryOf = (filters: Filters, cursor?: string): AdminAuditEventsQueryInput => ({
    ...(filters.action.length > 0 && { action: filters.action as AuditAction[] }),
    ...(filters.group !== '' && { group: filters.group as AuditGroup }),
    ...(filters.actorUserId.trim() !== '' && { actorUserId: filters.actorUserId.trim() }),
    ...(filters.targetUserId.trim() !== '' && { targetUserId: filters.targetUserId.trim() }),
    ...(filters.targetType !== '' && { targetType: filters.targetType as AuditTargetType }),
    ...(filters.targetId.trim() !== '' && { targetId: filters.targetId.trim() }),
    ...(filters.requestId.trim() !== '' && { requestId: filters.requestId.trim() }),
    ...(toIso(filters.from) !== undefined && { from: toIso(filters.from) }),
    ...(toIso(filters.to) !== undefined && { to: toIso(filters.to) }),
    ...(cursor !== undefined && { cursor }),
})

// feat-235 review: every first page starts a new generation. An answer of an older one (a "Load
// more" sent before the filters changed, a first page overtaken by the next) is dropped: it would
// append events of the old filters to the new list and replace its cursor.
let generation = 0

async function load(reset: boolean): Promise<void> {
    if (reset) {
        generation += 1
        loading.value = true
        loadingMore.value = false
    } else {
        loadingMore.value = true
    }
    const mine = generation
    error.value = null
    const filters = filtersFromQuery(route.query)
    const cursor = reset ? undefined : (nextCursor.value ?? undefined)
    const res = await adminAuditEventsApi.list(queryOf(filters, cursor))
    if (mine !== generation) return
    loading.value = false
    loadingMore.value = false
    if (res.data?.status === 'success') {
        items.value = reset ? res.data.items : [...items.value, ...res.data.items]
        nextCursor.value = res.data.nextCursor
        return
    }
    // A failed next page keeps what is shown.
    if (reset) {
        items.value = []
        nextCursor.value = null
    }
    error.value = getResponseMessage(res.data, res.error?.message ?? t('auditLog.states.error'))
}

function apply(): void {
    const query: Record<string, string | string[]> = {}
    if (form.value.action.length > 0) query.action = [...form.value.action]
    for (const key of SINGLE_KEYS) {
        const value = form.value[key].trim()
        if (value !== '') query[key] = value
    }
    void router.replace({ query })
}

function reset(): void {
    form.value = emptyFilters()
    void router.replace({ query: {} })
}

watch(
    () => route.query,
    (query) => {
        form.value = filtersFromQuery(query)
        expanded.value = null
        void load(true)
    },
    { immediate: true },
)

const actionKey = (action: string): string => action.replace(/\./g, '_')
const actionLabel = (action: string): string => t(`auditLog.actions.${actionKey(action)}`)
const groupLabel = (group: string): string => t(`auditLog.groups.${group.replace(/-/g, '_')}`)
const targetTypeLabel = (type: string): string => t(`auditLog.targetTypes.${type}`)

const actionOptions = computed(() =>
    AUDIT_ACTION_NAMES.map((action) => ({ value: action, label: actionLabel(action) })),
)

function actorLabel(event: AuditEvent): string {
    const { actor } = event
    if (actor.kind === 'proof_holder') {
        const proof = actor.proof === null ? '' : `: ${t(`auditLog.proofs.${actor.proof}`)}`
        return `${t('auditLog.actor.withoutSignIn')}${proof}`
    }
    if (actor.kind === 'system') {
        return actor.source === null
            ? t('auditLog.actor.system')
            : `${t('auditLog.actor.system')} (${actor.source})`
    }
    if (actor.deleted) return t('auditLog.actor.deleted', { id: actor.userId ?? '' })
    return actor.name ?? t('auditLog.actor.user', { id: actor.userId ?? '' })
}

function targetLabel(event: AuditEvent): string {
    const base = `${targetTypeLabel(event.target.type)} #${event.target.id}`
    const user = event.targetUser
    if (user === null || event.target.type !== 'user') return base
    if (user.deleted) return `${base} (${t('auditLog.actor.deleted', { id: user.id })})`
    return user.name === null ? base : `${base} (${user.name})`
}

type Plain = string | number | boolean | null | undefined

const shown = (value: Plain): string =>
    value === null || value === undefined ? '—' : String(value)

interface ChangeRow {
    field: string
    from: string
    to: string
}

function changeRows(event: AuditEvent): ChangeRow[] {
    const changes = event.changes
    if (changes === null) return []
    const rows: ChangeRow[] = []
    for (const [field, value] of Object.entries(changes)) {
        if ('changed' in value) {
            const fingerprint = value
            const side = (hash: string | null, chars: number | null): string =>
                hash === null
                    ? '—'
                    : `${hash.slice(0, 12)}… · ${t('auditLog.details.chars', { count: chars ?? 0 })}`
            rows.push({
                field: `content (${t(fingerprint.changed ? 'auditLog.details.changed' : 'auditLog.details.unchanged')})`,
                from: side(fingerprint.sha256Before, fingerprint.charsBefore),
                to: side(fingerprint.sha256After, fingerprint.charsAfter),
            })
            continue
        }
        rows.push({ field, from: shown(value.from), to: shown(value.to) })
    }
    return rows
}

const metadataRows = (event: AuditEvent): [string, string][] =>
    event.metadata === null
        ? []
        : Object.entries(event.metadata).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : shown(value),
          ])

function toggle(id: string): void {
    expanded.value = expanded.value === id ? null : id
}

async function copyRequestId(requestId: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(requestId)
        copied.value = requestId
    } catch {
        copied.value = null
    }
}
</script>

<template>
    <div class="audit-log">
        <div class="audit-log__header">
            <div>
                <h1 class="audit-log__title">{{ t('auditLog.title') }}</h1>
                <p class="audit-log__subtitle">{{ t('auditLog.subtitle') }}</p>
            </div>
        </div>

        <form class="audit-filters" data-testid="audit-filters" @submit.prevent="apply">
            <label>
                <span>{{ t('auditLog.filters.action') }}</span>
                <select v-model="form.action" name="action" multiple size="4">
                    <option
                        v-for="option in actionOptions"
                        :key="option.value"
                        :value="option.value"
                    >
                        {{ option.label }}
                    </option>
                </select>
            </label>
            <label>
                <span>{{ t('auditLog.filters.group') }}</span>
                <select v-model="form.group" name="group">
                    <option value="">{{ t('auditLog.filters.anyGroup') }}</option>
                    <option v-for="group in AUDIT_GROUPS" :key="group" :value="group">
                        {{ groupLabel(group) }}
                    </option>
                </select>
            </label>
            <label>
                <span>{{ t('auditLog.filters.targetType') }}</span>
                <select v-model="form.targetType" name="targetType">
                    <option value="">{{ t('auditLog.filters.anyTargetType') }}</option>
                    <option v-for="type in AUDIT_TARGET_TYPES" :key="type" :value="type">
                        {{ targetTypeLabel(type) }}
                    </option>
                </select>
            </label>
            <label>
                <span>{{ t('auditLog.filters.targetId') }}</span>
                <input v-model="form.targetId" name="targetId" type="text" />
            </label>
            <label>
                <span>{{ t('auditLog.filters.targetUserId') }}</span>
                <input
                    v-model="form.targetUserId"
                    name="targetUserId"
                    type="text"
                    inputmode="numeric"
                />
            </label>
            <label>
                <span>{{ t('auditLog.filters.actorUserId') }}</span>
                <input
                    v-model="form.actorUserId"
                    name="actorUserId"
                    type="text"
                    inputmode="numeric"
                />
            </label>
            <label>
                <span>{{ t('auditLog.filters.requestId') }}</span>
                <input v-model="form.requestId" name="requestId" type="text" />
            </label>
            <label>
                <span>{{ t('auditLog.filters.from') }}</span>
                <input v-model="form.from" name="from" type="datetime-local" step="1" />
            </label>
            <label>
                <span>{{ t('auditLog.filters.to') }}</span>
                <input v-model="form.to" name="to" type="datetime-local" step="1" />
            </label>
            <div class="audit-filters__actions">
                <button type="submit" class="btn btn--primary" :disabled="loading">
                    {{ t('auditLog.filters.apply') }}
                </button>
                <button type="button" class="btn" @click="reset">
                    {{ t('auditLog.filters.reset') }}
                </button>
            </div>
        </form>

        <div v-if="loading" class="audit-log__state" data-testid="audit-loading">
            {{ t('auditLog.states.loading') }}
        </div>
        <div
            v-else-if="error !== null && items.length === 0"
            class="audit-log__state audit-log__state--error"
            data-testid="audit-error"
        >
            {{ error }}
        </div>
        <div v-else-if="items.length === 0" class="audit-log__state" data-testid="audit-empty">
            {{ t('auditLog.states.empty') }}
        </div>

        <div v-else class="table-wrap">
            <table class="audit-table">
                <thead>
                    <tr>
                        <th>{{ t('auditLog.columns.time') }}</th>
                        <th>{{ t('auditLog.columns.actor') }}</th>
                        <th>{{ t('auditLog.columns.action') }}</th>
                        <th>{{ t('auditLog.columns.target') }}</th>
                        <th>{{ t('auditLog.columns.requestId') }}</th>
                    </tr>
                </thead>
                <tbody>
                    <template v-for="event in items" :key="event.id">
                        <tr
                            class="audit-table__row"
                            data-testid="audit-row"
                            :aria-expanded="expanded === event.id"
                            @click="toggle(event.id)"
                        >
                            <td class="cell-time">{{ formatDateTime(event.occurredAt) }}</td>
                            <td data-testid="audit-actor">{{ actorLabel(event) }}</td>
                            <td>{{ actionLabel(event.action) }}</td>
                            <td>{{ targetLabel(event) }}</td>
                            <td class="cell-mono">{{ event.requestId ?? '—' }}</td>
                        </tr>
                        <tr v-if="expanded === event.id" class="audit-table__details">
                            <td colspan="5" data-testid="audit-details">
                                <table v-if="changeRows(event).length > 0" class="changes-table">
                                    <thead>
                                        <tr>
                                            <th>{{ t('auditLog.details.field') }}</th>
                                            <th>{{ t('auditLog.details.from') }}</th>
                                            <th>{{ t('auditLog.details.to') }}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="row in changeRows(event)" :key="row.field">
                                            <td>{{ row.field }}</td>
                                            <td class="cell-mono">{{ row.from }}</td>
                                            <td class="cell-mono">{{ row.to }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                                <p v-else class="audit-log__muted">
                                    {{ t('auditLog.details.noChanges') }}
                                </p>
                                <dl v-if="metadataRows(event).length > 0" class="metadata">
                                    <template
                                        v-for="[key, value] in metadataRows(event)"
                                        :key="key"
                                    >
                                        <dt>{{ key }}</dt>
                                        <dd>{{ value }}</dd>
                                    </template>
                                </dl>
                                <button
                                    v-if="event.requestId !== null"
                                    type="button"
                                    class="btn"
                                    @click.stop="copyRequestId(event.requestId)"
                                >
                                    {{
                                        copied === event.requestId
                                            ? t('auditLog.details.copied')
                                            : t('auditLog.details.copy')
                                    }}
                                </button>
                            </td>
                        </tr>
                    </template>
                </tbody>
            </table>

            <div v-if="error !== null" class="audit-log__state audit-log__state--error">
                {{ error }}
            </div>

            <div v-if="nextCursor !== null" class="load-more-wrap">
                <button
                    class="load-more-btn"
                    type="button"
                    data-testid="audit-load-more"
                    :disabled="loadingMore"
                    @click="load(false)"
                >
                    {{
                        loadingMore
                            ? t('auditLog.states.loadingMore')
                            : t('auditLog.states.loadMore')
                    }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.audit-log {
    padding: 24px;
    color: var(--text-primary);
}

.audit-log__header {
    margin-bottom: 20px;
}

.audit-log__title {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
}

.audit-log__subtitle,
.audit-log__muted {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.audit-filters {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
    font-size: 0.8125rem;
}

.audit-filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-secondary);
}

.audit-filters input,
.audit-filters select {
    padding: 6px 8px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.875rem;
}

.audit-filters__actions {
    display: flex;
    gap: 8px;
    align-items: flex-end;
}

.btn {
    appearance: none;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 0.8125rem;
    cursor: pointer;
}

.btn--primary {
    border-color: var(--accent-color);
    background: var(--accent-color);
    color: white;
}

.audit-log__state {
    color: var(--text-secondary);
    font-size: 0.875rem;
}

.audit-log__state--error {
    color: var(--danger-color, #c0392b);
}

.table-wrap {
    overflow-x: auto;
}

.audit-table,
.changes-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
}

.audit-table th,
.audit-table td,
.changes-table th,
.changes-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-color);
    text-align: left;
    vertical-align: top;
}

.audit-table th,
.changes-table th {
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.8125rem;
}

.audit-table__row {
    cursor: pointer;
}

.audit-table__row:hover {
    background: color-mix(in srgb, var(--accent-color) 6%, transparent);
}

.audit-table__details > td {
    background: color-mix(in srgb, var(--accent-color) 3%, transparent);
}

.cell-time {
    white-space: nowrap;
}

.cell-mono {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
    word-break: break-all;
}

.metadata {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 12px 0;
    font-size: 0.8125rem;
}

.metadata dt {
    color: var(--text-secondary);
}

.metadata dd {
    margin: 0;
}

.load-more-wrap {
    display: flex;
    justify-content: center;
    margin-top: 20px;
}

.load-more-btn {
    appearance: none;
    border: 1px solid var(--accent-color);
    background: var(--accent-color);
    color: white;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 0.875rem;
    cursor: pointer;
}

.load-more-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

@media (max-width: 900px) {
    .audit-log {
        padding: 16px;
    }
}
</style>
