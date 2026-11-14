<script setup lang="ts">
import type { LandingContent } from '../content/types'
import AuthButtons from './AuthButtons.vue'

defineProps<{ content: LandingContent; appUrl: string }>()
</script>

<template>
    <section id="try" class="section cta" aria-labelledby="try-title">
        <div class="container cta__inner">
            <h2 id="try-title" class="section__title">{{ content.cta.title }}</h2>
            <p class="section__lead">{{ content.cta.text }}</p>
            <AuthButtons :content="content" :app-url="appUrl" />
        </div>
    </section>
</template>
