<script setup lang="ts">
import type { FeatureItem } from '../content/types'

withDefaults(
    defineProps<{
        id: string
        title: string
        lead: string
        items: readonly FeatureItem[]
        tone?: 'plain' | 'muted'
    }>(),
    { tone: 'plain' },
)
</script>

<template>
    <section :id="id" :class="['section', `section--${tone}`]" :aria-labelledby="`${id}-title`">
        <div class="container">
            <h2 :id="`${id}-title`" class="section__title">{{ title }}</h2>
            <p class="section__lead">{{ lead }}</p>
            <ul class="card-grid">
                <li v-for="item in items" :key="item.title" class="card">
                    <h3 class="card__title">{{ item.title }}</h3>
                    <p class="card__text">{{ item.text }}</p>
                </li>
            </ul>
        </div>
    </section>
</template>
