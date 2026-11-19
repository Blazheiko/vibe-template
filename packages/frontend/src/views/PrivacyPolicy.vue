<template>
    <main class="static-view">
        <section class="static-section">
            <h1>Privacy Policy</h1>
            <p>
                We process account, authentication, support chat, and service metadata needed to
                operate retained features.
            </p>
            <p>
                Each signed-in session keeps the IP address and the browser User-Agent it signed in
                from, and when it was last active. They are shown to you on the account page and
                deleted with the session, when it ends or expires.
            </p>
        </section>
    </main>
</template>

<style scoped>
.static-view {
    min-height: 100dvh;
    padding: 32px 20px;
    background: var(--bg-primary);
    color: var(--text-primary);
}

.static-section {
    max-width: 760px;
    margin: 0 auto;
}

h1 {
    margin: 0 0 12px;
    font-size: 28px;
}

p {
    margin: 0 0 12px;
    color: var(--text-secondary);
}
</style>
