<script setup lang="ts">
export interface AdminFilters {
    userId: string
    dateFrom: string
    dateTo: string
}

// The filter card the admin lists share: a user id and a date range, applied or reset. The
// parent owns the values (v-model) and what applying does.
defineProps<{
    fromLabel: string
    toLabel: string
    /** Waiting for a list: the buttons are off, and Apply says so. */
    loading: boolean
    /** The buttons are off for another reason too (the next page is loading). */
    busy?: boolean
}>()

const filters = defineModel<AdminFilters>({ required: true })

defineEmits<{ submit: []; reset: [] }>()
</script>

<template>
    <form class="filters-card" @submit.prevent="$emit('submit')">
        <div class="filters-grid">
            <div class="form-field">
                <label class="form-label">User ID</label>
                <input
                    v-model="filters.userId"
                    class="form-input"
                    inputmode="numeric"
                    placeholder="e.g. 123"
                />
            </div>

            <div class="form-field">
                <label class="form-label">{{ fromLabel }}</label>
                <input v-model="filters.dateFrom" class="form-input" type="date" />
            </div>

            <div class="form-field">
                <label class="form-label">{{ toLabel }}</label>
                <input v-model="filters.dateTo" class="form-input" type="date" />
            </div>
        </div>

        <div class="filters-actions">
            <button class="btn btn--primary" type="submit" :disabled="loading || busy">
                {{ loading ? 'Loading...' : 'Apply' }}
            </button>
            <button class="btn" type="button" :disabled="loading || busy" @click="$emit('reset')">
                Reset
            </button>
        </div>
    </form>
</template>

<style scoped>
.filters-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 18px 20px;
    margin-bottom: 20px;
}

.filters-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px 16px;
}

.form-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.form-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
}

.form-input {
    padding: 8px 10px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.875rem;
    width: 100%;
    box-sizing: border-box;
}

.filters-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
}

.btn {
    appearance: none;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-primary);
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
        background-color 0.15s ease,
        border-color 0.15s ease,
        color 0.15s ease,
        opacity 0.15s ease;
}

.btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color) 6%, var(--bg-primary));
    border-color: color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
}

.btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn--primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
}

.btn--primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color) 88%, black);
    border-color: color-mix(in srgb, var(--accent-color) 88%, black);
}
</style>
