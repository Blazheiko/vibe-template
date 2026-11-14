<script setup lang="ts">
import { CONTENT, LOCALE_PATHS, LOCALES, type Locale } from '../pages'

// Plain links: each locale is its own prerendered page, so switching needs no JavaScript.
defineProps<{ locale: Locale; label: string }>()
</script>

<template>
    <nav class="locale-switcher" :aria-label="label">
        <a
            v-for="item in LOCALES"
            :key="item"
            :href="LOCALE_PATHS[item]"
            :hreflang="item"
            :lang="item"
            :aria-current="item === locale ? 'page' : undefined"
            data-testid="locale-link"
            >{{ CONTENT[item].languageName }}</a
        >
    </nav>
</template>
