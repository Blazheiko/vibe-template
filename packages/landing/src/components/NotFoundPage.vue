<script setup lang="ts">
import { CONTENT, LOCALE_PATHS, LOCALES } from '../pages'

// One 404.html serves every locale, so it speaks all three.
</script>

<template>
    <main id="main" class="not-found" data-page="not-found">
        <div class="container not-found__inner">
            <section v-for="locale in LOCALES" :key="locale" :lang="locale" class="not-found__item">
                <h1 v-if="locale === 'en'" class="not-found__title">
                    404 · {{ CONTENT[locale].notFound.title }}
                </h1>
                <h2 v-else class="not-found__title">{{ CONTENT[locale].notFound.title }}</h2>
                <p>{{ CONTENT[locale].notFound.text }}</p>
                <a class="button button--secondary" :href="LOCALE_PATHS[locale]">{{
                    CONTENT[locale].notFound.home
                }}</a>
            </section>
        </div>
    </main>
</template>
