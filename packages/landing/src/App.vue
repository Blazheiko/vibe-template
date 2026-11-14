<script setup lang="ts">
import { computed } from 'vue'
import { CONTENT, type PageId } from './pages'
import SiteHeader from './components/SiteHeader.vue'
import HeroSection from './components/HeroSection.vue'
import CardGrid from './components/CardGrid.vue'
import AudienceSection from './components/AudienceSection.vue'
import GetStartedSection from './components/GetStartedSection.vue'
import CtaSection from './components/CtaSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import NotFoundPage from './components/NotFoundPage.vue'

const props = defineProps<{
    page: PageId
    /** Origin of the application: the buttons lead to its /login and /register. */
    appUrl: string
}>()

const locale = computed(() => (props.page === 'not-found' ? 'en' : props.page))
const content = computed(() => CONTENT[locale.value])
</script>

<template>
    <NotFoundPage v-if="page === 'not-found'" />
    <template v-else>
        <SiteHeader :locale="locale" :content="content" />
        <main id="main">
            <HeroSection :content="content" :app-url="appUrl" />
            <CardGrid
                id="features"
                :title="content.features.title"
                :lead="content.features.lead"
                :items="content.features.items"
            />
            <CardGrid
                id="stack"
                tone="muted"
                :title="content.stack.title"
                :lead="content.stack.lead"
                :items="content.stack.items"
            />
            <AudienceSection :content="content" />
            <GetStartedSection :locale="locale" :content="content" />
            <CtaSection :content="content" :app-url="appUrl" />
        </main>
        <SiteFooter :locale="locale" :content="content" :app-url="appUrl" />
    </template>
</template>
