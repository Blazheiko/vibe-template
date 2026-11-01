<script setup lang="ts">
const emit = defineEmits<{ install: [] }>()
</script>

<template>
    <button type="button" class="menu-item install-app" @click="emit('install')">
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="currentColor"
        >
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
        </svg>
        Install App
    </button>
</template>
