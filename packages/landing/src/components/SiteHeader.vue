<script setup lang="ts">
import { PRODUCT } from 'shared/product'
import type { LandingContent } from '../content/types'
import { docsUrl, LOCALE_PATHS, type Locale } from '../pages'
import LocaleSwitcher from './LocaleSwitcher.vue'

defineProps<{ locale: Locale; content: LandingContent }>()
</script>

<template>
    <header class="site-header">
        <div class="container site-header__inner">
            <a class="brand" :href="LOCALE_PATHS[locale]">
                <img class="brand__logo" src="/favicon.svg" alt="" width="32" height="32" />
                <span class="brand__name">{{ PRODUCT.name }}</span>
            </a>
            <nav class="site-nav" :aria-label="content.nav.label">
                <a href="#features">{{ content.nav.features }}</a>
                <a href="#stack">{{ content.nav.stack }}</a>
                <a href="#start">{{ content.nav.start }}</a>
                <a :href="docsUrl(locale)">{{ content.nav.docs }}</a>
            </nav>
            <LocaleSwitcher :locale="locale" :label="content.nav.language" />
        </div>
    </header>
</template>
