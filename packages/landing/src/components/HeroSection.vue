<script setup lang="ts">
import type { LandingContent } from '../content/types'
import AuthButtons from './AuthButtons.vue'

defineProps<{ content: LandingContent; appUrl: string }>()
</script>

<template>
    <section class="hero" aria-labelledby="hero-title">
        <div class="container">
            <p class="hero__eyebrow">{{ content.hero.eyebrow }}</p>
            <h1 id="hero-title" class="hero__title">{{ content.hero.title }}</h1>
            <p class="hero__lead">{{ content.description }}</p>
            <AuthButtons :content="content" :app-url="appUrl" />
        </div>
    </section>
</template>
