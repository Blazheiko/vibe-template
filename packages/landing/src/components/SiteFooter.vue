<script setup lang="ts">
import { PRODUCT } from 'shared/product'
import type { LandingContent } from '../content/types'
import { docsUrl, REPOSITORY_URL, type Locale } from '../pages'
import LocaleSwitcher from './LocaleSwitcher.vue'

defineProps<{ locale: Locale; content: LandingContent; appUrl: string }>()
</script>

<template>
    <footer class="site-footer">
        <div class="container site-footer__inner">
            <p class="site-footer__name">{{ PRODUCT.name }}</p>
            <nav class="site-footer__links" :aria-label="content.footer.label">
                <a :href="`${appUrl}/privacy-policy`">{{ content.footer.privacy }}</a>
                <a :href="`${appUrl}/terms`">{{ content.footer.terms }}</a>
                <a :href="docsUrl(locale)">{{ content.footer.docs }}</a>
                <a :href="REPOSITORY_URL">{{ content.footer.repository }}</a>
            </nav>
            <LocaleSwitcher :locale="locale" :label="content.nav.language" />
        </div>
    </footer>
</template>
