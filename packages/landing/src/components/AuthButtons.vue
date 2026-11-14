<script setup lang="ts">
import type { LandingContent } from '../content/types'

// The app opens its sign-in and sign-up dialogs on these routes (frontend/src/router/index.ts).
defineProps<{ content: LandingContent; appUrl: string }>()
</script>

<template>
    <div class="auth-buttons">
        <a class="button button--primary" :href="`${appUrl}/register`" data-testid="cta-register">{{
            content.hero.register
        }}</a>
        <a class="button button--secondary" :href="`${appUrl}/login`" data-testid="cta-login">{{
            content.hero.login
        }}</a>
    </div>
</template>
