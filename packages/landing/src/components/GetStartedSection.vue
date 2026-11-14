<script setup lang="ts">
import type { LandingContent } from '../content/types'
import { docsUrl, REPOSITORY_URL, type Locale } from '../pages'

defineProps<{ locale: Locale; content: LandingContent }>()
</script>

<template>
    <section id="start" class="section section--muted" aria-labelledby="start-title">
        <div class="container">
            <h2 id="start-title" class="section__title">{{ content.start.title }}</h2>
            <p class="section__lead">{{ content.start.lead }}</p>
            <ol class="steps">
                <li v-for="step in content.start.steps" :key="step.title" class="step">
                    <code class="step__command">{{ step.title }}</code>
                    <span class="step__text">{{ step.text }}</span>
                </li>
            </ol>
            <p class="links">
                <a :href="docsUrl(locale)">{{ content.start.docs }}</a>
                <a :href="REPOSITORY_URL">{{ content.start.repository }}</a>
            </p>
        </div>
    </section>
</template>
