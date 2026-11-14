<script setup lang="ts">
import type { LandingContent } from '../content/types'

defineProps<{ content: LandingContent }>()
</script>

<template>
    <section id="audience" class="section" aria-labelledby="audience-title">
        <div class="container">
            <h2 id="audience-title" class="section__title">{{ content.audience.title }}</h2>
            <ul class="check-list">
                <li v-for="item in content.audience.items" :key="item">{{ item }}</li>
            </ul>
        </div>
    </section>
</template>
