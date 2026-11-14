<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { adminKnowledgeBaseApi } from '@/utils/api'
import type { KnowledgeBaseArticle, KnowledgeBaseInitStatus } from '@/utils/api'

const articles = ref<KnowledgeBaseArticle[]>([])
const total = ref(0)
const isLoading = ref(false)
const error = ref<string | null>(null)
// What the last delete, reindex or screenshot action could not do.
const actionError = ref<string | null>(null)

// Form state
const showForm = ref(false)
const isEditing = ref(false)
const isSaving = ref(false)
const formId = ref<string | null>(null)
const formTitle = ref('')
const formContent = ref('')
const formCategory = ref('')
const formIsActive = ref(true)
const formError = ref<string | null>(null)

// Screenshot
const screenshotFile = ref<File | null>(null)
const screenshotInput = ref<HTMLInputElement | null>(null)

// Reindex
const isReindexingAll = ref(false)
const reindexResult = ref<string | null>(null)
const initStatus = ref<KnowledgeBaseInitStatus | null>(null)
const initError = ref<string | null>(null)
const isInitStarting = ref(false)
let initPollTimer: number | null = null

const isInitRunning = computed(() => initStatus.value?.state === 'running')
// A list that failed to load is not an empty knowledge base: no offer to initialise it.
const showInitButton = computed(
    () => !isLoading.value && error.value === null && total.value === 0 && !isInitRunning.value,
)
const showInitProgress = computed(
    () => initStatus.value !== null && initStatus.value.state !== 'idle',
)

function stopInitPolling(): void {
    if (initPollTimer !== null) {
        window.clearInterval(initPollTimer)
        initPollTimer = null
    }
}

async function refreshInitStatus(): Promise<void> {
    const status = await adminKnowledgeBaseApi.getInitStatus()
    if (status === null) return

    const previousState = initStatus.value?.state
    initStatus.value = status

    if (status.state === 'completed' || status.state === 'failed') {
        stopInitPolling()
        if (previousState === 'running') {
            await loadArticles()
        }
    }
}

function startInitPolling(): void {
    stopInitPolling()
    initPollTimer = window.setInterval(() => {
        void refreshInitStatus()
    }, 1000)
}

async function loadArticles(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
        const result = await adminKnowledgeBaseApi.getAll({ limit: 100 })
        articles.value = result.items
        total.value = result.total
    } catch (e) {
        error.value = e instanceof Error ? e.message : 'Failed to load'
    } finally {
        isLoading.value = false
    }
}

function openCreate(): void {
    isEditing.value = false
    formId.value = null
    formTitle.value = ''
    formContent.value = ''
    formCategory.value = ''
    formIsActive.value = true
    formError.value = null
    screenshotFile.value = null
    showForm.value = true
}

function openEdit(article: KnowledgeBaseArticle): void {
    isEditing.value = true
    formId.value = article.id
    formTitle.value = article.title
    formContent.value = article.content
    formCategory.value = article.category ?? ''
    formIsActive.value = article.isActive
    formError.value = null
    screenshotFile.value = null
    showForm.value = true
}

function cancelForm(): void {
    showForm.value = false
}

async function saveForm(): Promise<void> {
    if (!formTitle.value.trim() || !formContent.value.trim()) {
        formError.value = 'Title and content are required'
        return
    }
    isSaving.value = true
    formError.value = null
    try {
        const payload = {
            title: formTitle.value.trim(),
            content: formContent.value.trim(),
            category: formCategory.value.trim() || undefined,
            isActive: formIsActive.value,
        }
        let saved: KnowledgeBaseArticle | null = null
        if (isEditing.value && formId.value !== null) {
            saved = await adminKnowledgeBaseApi.update(formId.value, payload)
        } else {
            saved = await adminKnowledgeBaseApi.create(payload)
        }
        if (saved === null) {
            formError.value = 'Failed to save article'
            return
        }
        // Upload screenshot if selected
        actionError.value = null
        if (screenshotFile.value !== null) {
            const uploaded = await adminKnowledgeBaseApi.uploadScreenshot(
                saved.id,
                screenshotFile.value,
            )
            if (uploaded === null) {
                actionError.value = 'The article was saved, but its screenshot was not uploaded'
            }
        }
        showForm.value = false
        await loadArticles()
    } catch (e) {
        formError.value = e instanceof Error ? e.message : 'Failed to save'
    } finally {
        isSaving.value = false
    }
}

async function deleteArticle(article: KnowledgeBaseArticle): Promise<void> {
    if (!confirm(`Delete "${article.title}"?`)) return
    const deleted = await adminKnowledgeBaseApi.delete(article.id)
    actionError.value = deleted ? null : `Failed to delete "${article.title}"`
    await loadArticles()
}

async function reindexArticle(article: KnowledgeBaseArticle): Promise<void> {
    const reindexed = await adminKnowledgeBaseApi.reindex(article.id)
    actionError.value = reindexed ? null : `Failed to reindex "${article.title}"`
    await loadArticles()
}

async function reindexAll(): Promise<void> {
    isReindexingAll.value = true
    reindexResult.value = null
    try {
        const result = await adminKnowledgeBaseApi.reindexAll()
        if (result === null) {
            actionError.value = 'Failed to reindex the knowledge base'
            return
        }
        actionError.value = null
        const failed =
            result.failed.length > 0
                ? `, ${String(result.failed.length)} failed (ids: ${result.failed.join(', ')})`
                : ''
        reindexResult.value = `Indexed ${String(result.indexed)} article(s)${failed}`
        await loadArticles()
    } finally {
        isReindexingAll.value = false
    }
}

async function startInit(): Promise<void> {
    if (isInitStarting.value || isInitRunning.value) return

    isInitStarting.value = true
    initError.value = null

    try {
        const result = await adminKnowledgeBaseApi.startInit()
        if (!result.ok) {
            initStatus.value = result.status
            initError.value = result.message
            return
        }

        initStatus.value = result.status
        startInitPolling()
        await refreshInitStatus()
    } finally {
        isInitStarting.value = false
    }
}

function onScreenshotChange(e: Event): void {
    const target = e.target as HTMLInputElement
    screenshotFile.value = target.files?.[0] ?? null
}

async function deleteScreenshot(article: KnowledgeBaseArticle): Promise<void> {
    const updated = await adminKnowledgeBaseApi.deleteScreenshot(article.id)
    actionError.value =
        updated === null ? `Failed to delete the screenshot of "${article.title}"` : null
    await loadArticles()
}

onMounted(() => {
    void loadArticles()
    void refreshInitStatus().then(() => {
        if (initStatus.value?.state === 'running') {
            startInitPolling()
        }
    })
})

onUnmounted(() => {
    stopInitPolling()
})
</script>

<template>
    <div class="kb-view">
        <div class="kb-header">
            <h2 class="kb-heading">Knowledge Base</h2>
            <div class="kb-header-actions">
                <button class="btn btn-secondary" :disabled="isReindexingAll" @click="reindexAll">
                    {{ isReindexingAll ? 'Reindexing...' : 'Reindex All' }}
                </button>
                <button
                    v-if="showInitButton"
                    class="btn btn-secondary"
                    :disabled="isInitStarting"
                    @click="startInit"
                >
                    {{ isInitStarting ? 'Starting...' : 'Init' }}
                </button>
                <button class="btn btn-primary" @click="openCreate">+ New Article</button>
            </div>
        </div>

        <p v-if="reindexResult" class="kb-reindex-result">{{ reindexResult }}</p>
        <p v-if="initError" class="kb-error">{{ initError }}</p>
        <p v-if="actionError" class="kb-error" role="alert">{{ actionError }}</p>

        <div v-if="showInitProgress" class="kb-init-card" :class="`is-${initStatus?.state}`">
            <div class="kb-init-head">
                <div>
                    <h3 class="kb-init-title">Initialization</h3>
                    <p class="kb-init-subtitle">
                        {{
                            initStatus?.message ??
                            'Importing knowledge base articles from docs/support-knowledge-base'
                        }}
                    </p>
                </div>
                <span class="kb-init-state">{{ initStatus?.state }}</span>
            </div>

            <div class="kb-progress-bar">
                <div
                    class="kb-progress-fill"
                    :style="{ width: `${initStatus?.progressPercent ?? 0}%` }"
                />
            </div>

            <div class="kb-init-stats">
                <span
                    >{{ initStatus?.processedFiles ?? 0 }} /
                    {{ initStatus?.totalFiles ?? 0 }} files</span
                >
                <span>{{ initStatus?.createdArticles ?? 0 }} created</span>
                <span v-if="(initStatus?.failedFiles ?? 0) > 0"
                    >{{ initStatus?.failedFiles ?? 0 }} failed</span
                >
                <span>{{ initStatus?.progressPercent ?? 0 }}%</span>
            </div>

            <p v-if="initStatus?.currentFile" class="kb-init-current">
                Current file: {{ initStatus.currentFile }}
            </p>
        </div>

        <div v-if="isLoading" class="kb-loading">Loading...</div>
        <p v-else-if="error" class="kb-error" role="alert">{{ error }}</p>

        <div v-else class="kb-table-wrap">
            <table class="kb-table">
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Category</th>
                        <th>Active</th>
                        <th>Indexed</th>
                        <th>Screenshot</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="article in articles" :key="article.id">
                        <td class="kb-title-cell">{{ article.title }}</td>
                        <td>{{ article.category ?? '—' }}</td>
                        <td>{{ article.isActive ? 'Yes' : 'No' }}</td>
                        <td>{{ article.embeddingIndexed ? 'Yes' : 'No' }}</td>
                        <td>{{ article.hasScreenshot ? 'Yes' : 'No' }}</td>
                        <td class="kb-actions-cell">
                            <button class="btn-xs btn-secondary" @click="openEdit(article)">
                                Edit
                            </button>
                            <button class="btn-xs btn-secondary" @click="reindexArticle(article)">
                                Reindex
                            </button>
                            <button
                                v-if="article.hasScreenshot"
                                class="btn-xs btn-danger"
                                @click="deleteScreenshot(article)"
                            >
                                Del Screenshot
                            </button>
                            <button class="btn-xs btn-danger" @click="deleteArticle(article)">
                                Delete
                            </button>
                        </td>
                    </tr>
                    <tr v-if="articles.length === 0">
                        <td colspan="6" class="kb-empty">No articles yet</td>
                    </tr>
                </tbody>
            </table>
            <p class="kb-count">Total: {{ total }}</p>
        </div>

        <!-- Article form modal -->
        <div v-if="showForm" class="kb-modal-overlay" @click.self="cancelForm">
            <div class="kb-modal">
                <h3 class="kb-modal-title">{{ isEditing ? 'Edit Article' : 'New Article' }}</h3>
                <label class="kb-label">
                    Title *
                    <input
                        v-model="formTitle"
                        class="kb-input"
                        type="text"
                        placeholder="Article title"
                    />
                </label>
                <label class="kb-label">
                    Category
                    <input
                        v-model="formCategory"
                        class="kb-input"
                        type="text"
                        placeholder="e.g. billing, setup"
                    />
                </label>
                <label class="kb-label">
                    Content *
                    <textarea
                        v-model="formContent"
                        class="kb-textarea"
                        rows="8"
                        placeholder="Article content (Markdown supported)"
                    />
                </label>
                <label class="kb-label kb-label--row">
                    <input v-model="formIsActive" type="checkbox" />
                    Active
                </label>
                <label class="kb-label">
                    Screenshot (optional)
                    <input
                        ref="screenshotInput"
                        type="file"
                        accept="image/*"
                        class="kb-file-input"
                        @change="onScreenshotChange"
                    />
                </label>
                <p v-if="formError" class="kb-form-error">{{ formError }}</p>
                <div class="kb-modal-actions">
                    <button class="btn btn-secondary" @click="cancelForm">Cancel</button>
                    <button class="btn btn-primary" :disabled="isSaving" @click="saveForm">
                        {{ isSaving ? 'Saving...' : 'Save' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.kb-view {
    padding: 24px;
    max-width: 1100px;
}

.kb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
}

.kb-heading {
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
}

.kb-header-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.kb-reindex-result {
    font-size: 13px;
    color: var(--color-success, #2e7d52);
    margin-bottom: 12px;
}

.kb-init-card {
    margin-bottom: 16px;
    padding: 16px;
    border: 1px solid var(--border-color);
    border-radius: 14px;
    background: var(--bg-secondary);
}

.kb-init-card.is-running {
    border-color: var(--accent-color, #a05a72);
}

.kb-init-card.is-completed {
    border-color: var(--color-success, #2e7d52);
}

.kb-init-card.is-failed {
    border-color: var(--color-danger, #b83232);
}

.kb-init-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
}

.kb-init-title {
    margin: 0 0 4px;
    font-size: 16px;
    color: var(--text-primary);
}

.kb-init-subtitle {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
}

.kb-init-state {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    font-size: 12px;
    text-transform: capitalize;
    color: var(--text-primary);
}

.kb-progress-bar {
    width: 100%;
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
}

.kb-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-color, #a05a72), var(--accent-hover, #8b4f64));
    transition: width 0.2s ease;
}

.kb-init-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-secondary);
}

.kb-init-current {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--text-primary);
}

.kb-loading {
    color: var(--text-secondary);
    padding: 24px 0;
}

.kb-error {
    color: var(--color-danger);
}

.kb-table-wrap {
    overflow-x: auto;
}

.kb-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}

.kb-table th,
.kb-table td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border-color);
}

.kb-table th {
    color: var(--text-secondary);
    font-weight: 500;
    background-color: var(--bg-secondary);
}

.kb-title-cell {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.kb-actions-cell {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.kb-empty {
    color: var(--text-secondary);
    text-align: center;
    padding: 24px;
}

.kb-count {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 8px;
}

.btn {
    padding: 8px 16px;
    border: 1px solid transparent;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    font-weight: 500;
    transition:
        background-color 0.15s,
        border-color 0.15s,
        color 0.15s,
        opacity 0.15s;
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-primary {
    background-color: var(--accent-color, #a05a72);
    border-color: var(--accent-color, #a05a72);
    color: #fff;
}

.btn-primary:hover:not(:disabled) {
    background-color: var(--accent-hover, #8b4f64);
    border-color: var(--accent-hover, #8b4f64);
}

.btn-secondary {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
    border-color: var(--accent-color, #a05a72);
    color: var(--accent-color, #a05a72);
}

.btn-xs {
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
}

.btn-xs.btn-secondary {
    background-color: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.btn-xs.btn-danger {
    background-color: transparent;
    color: var(--color-danger, #b83232);
    border: 1px solid var(--color-danger, #b83232);
}

/* Modal */
.kb-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.kb-modal {
    background: var(--bg-secondary);
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    max-width: 600px;
    max-height: 90dvh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.kb-modal-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
}

.kb-label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--text-secondary);
    font-weight: 500;
}

.kb-label--row {
    flex-direction: row;
    align-items: center;
}

.kb-input,
.kb-textarea {
    background-color: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--text-primary);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
}

.kb-input:focus,
.kb-textarea:focus {
    border-color: var(--accent-primary);
}

.kb-textarea {
    resize: vertical;
    min-height: 140px;
}

.kb-file-input {
    font-size: 13px;
    color: var(--text-secondary);
}

.kb-form-error {
    color: var(--color-danger);
    font-size: 13px;
    margin: 0;
}

.kb-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
}
</style>
