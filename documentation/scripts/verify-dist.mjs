// Verifies the built site in .vitepress/dist (plan §5, stage 4; task list T2.1–T2.5).
// Content checks look only inside the article container (.vp-doc), never at nav/sidebar/footer.
// Usage: node scripts/verify-dist.mjs   (after `vitepress build`)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'node-html-parser'
import { parse as parseYaml } from 'yaml'
import {
    classifyUrl,
    countMermaidBlocks,
    deriveMarkers,
    extractIncludes,
    markdownToDist,
    normalizeText,
    resolveInternalUrl,
    srcsetUrls,
    uncoveredPaths,
    workflowPaths,
} from './verify/lib.mjs'

const BASE = '/vibe-template/'
const MIN_ARTICLE_CHARS = 300
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, '.vitepress', 'dist')
const REPO = path.resolve(ROOT, '..')
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'docs.yml')
const SKIP_DIRS = new Set(['.vitepress', 'node_modules', 'public', 'scripts'])

/**
 * Key article pages (T2.3). Add each page here in the same task that writes it.
 * `h1` is the expected article title.
 */
const KEY_PAGES = [
    { page: 'guide/introduction.md', h1: 'Вступ' },
    { page: 'guide/getting-started.md', h1: 'Швидкий старт' },
    { page: 'guide/how-backend-works.md', h1: 'Як влаштований бекенд' },
    { page: 'guide/http-request.md', h1: 'Від HTTP-запиту до контролера' },
    { page: 'guide/http-response.md', h1: 'Від контролера до HTTP-відповіді' },
    { page: 'guide/first-endpoint.md', h1: 'Перший маршрут' },
    { page: 'guide/your-project.md', h1: 'Свій проєкт на шаблоні' },
    { page: 'guide/project-structure.md', h1: 'Структура проєкту' },
    { page: 'guide/csrf.md', h1: 'CSRF простими словами' },
    { page: 'backend/index.md', h1: 'Огляд бекенду' },
    { page: 'backend/architecture.md', h1: 'Архітектура бекенду' },
    { page: 'backend/request-lifecycle.md', h1: 'Життєвий цикл запиту' },
    { page: 'backend/configuration.md', h1: 'Конфігурація' },
    { page: 'backend/routing.md', h1: 'Маршрутизація' },
    { page: 'backend/middlewares.md', h1: 'Middleware' },
    { page: 'backend/web-and-api-routes.md', h1: 'Веб-маршрути і публічний API' },
    { page: 'backend/database.md', h1: 'База даних' },
    { page: 'backend/auth.md', h1: 'Автентифікація' },
    { page: 'backend/oauth.md', h1: 'Вхід через соцмережі' },
    { page: 'backend/security.md', h1: 'Безпека' },
    { page: 'backend/websocket.md', h1: 'WebSocket' },
    { page: 'backend/controllers.md', h1: 'Контролери' },
    { page: 'backend/services.md', h1: 'Сервіси' },
    { page: 'backend/repositories.md', h1: 'Репозиторії' },
    { page: 'backend/transformers.md', h1: 'Трансформери' },
    { page: 'backend/validation.md', h1: 'Валідація' },
    { page: 'backend/response-validation.md', h1: 'Перевірка відповідей' },
    { page: 'backend/deployment.md', h1: 'Деплой' },
    { page: 'backend/observability.md', h1: 'Observability' },
    { page: 'backend/testing.md', h1: 'Тестування' },
    { page: 'backend/caching-etag.md', h1: 'Кешування та ETag' },
    { page: 'backend/storage.md', h1: 'Сховище файлів (S3)' },
    { page: 'backend/mail.md', h1: 'Пошта' },
    { page: 'backend/web-push-notification.md', h1: 'Web Push сповіщення' },
    { page: 'backend/ai.md', h1: 'AI-інтеграції' },
    { page: 'backend/adding-a-feature.md', h1: 'Як додати фічу в бекенд' },
    { page: 'reference/scripts.md', h1: 'Скрипти' },
    { page: 'guide/workflow.md', h1: 'Процес роботи' },
    { page: 'reference/toolchain.md', h1: 'Toolchain' },
    { page: 'reference/glossary.md', h1: 'Глосарій' },
    { page: 'reference/roles-capabilities.md', h1: 'Ролі та можливості' },
    { page: 'reference/author.md', h1: 'Про автора' },
    { page: 'shared/index.md', h1: 'Пакет shared' },
    { page: 'frontend/index.md', h1: 'Фронтенд' },
    { page: 'playground/index.md', h1: 'API Playground' },
]

/** Home page (layout: home) checks (T2.3a). */
const HOME = {
    page: 'index.md',
    name: 'vibe-template',
    tagline: 'розробки застосунків з AI-агентами',
}

/**
 * Explicit include markers, keyed by include path as written in the directive.
 * Required for partial includes (#region / {lines}); optional override otherwise.
 */
const INCLUDE_MARKERS = {}

const errors = []
/** Repo-relative POSIX paths of every include source, collected by checkSources (T3.3). */
const includeSources = new Set()
const fail = (where, message) => errors.push(`${where}: ${message}`)

const htmlCache = new Map()
function loadHtml(relFile) {
    if (!htmlCache.has(relFile)) {
        const abs = path.join(DIST, relFile)
        htmlCache.set(relFile, existsSync(abs) ? parse(readFileSync(abs, 'utf8')) : null)
    }
    return htmlCache.get(relFile)
}

function walk(dir, filter, out = []) {
    for (const entry of readdirSync(dir)) {
        const abs = path.join(dir, entry)
        if (statSync(abs).isDirectory()) {
            if (!SKIP_DIRS.has(entry) || dir !== ROOT) walk(abs, filter, out)
        } else if (filter(entry)) {
            out.push(abs)
        }
    }
    return out
}

function articleOf(relHtml, where) {
    const root = loadHtml(relHtml)
    if (root === null) {
        fail(where, `missing ${relHtml} in dist`)
        return null
    }
    const article = root.querySelector('.vp-doc')
    if (article === null) fail(where, 'no .vp-doc article container')
    return article
}

function textWithoutHeadings(article) {
    const clone = parse(article.outerHTML)
    for (const h of clone.querySelectorAll('h1, h2, h3, h4, h5, h6')) h.remove()
    return normalizeText(clone.textContent)
}

// T2.2 + T2.5: includes and Mermaid, driven by the Markdown sources.
function checkSources() {
    const mdFiles = walk(ROOT, (name) => name.endsWith('.md'))
    for (const mdAbs of mdFiles) {
        const mdRel = path.relative(ROOT, mdAbs).split(path.sep).join('/')
        const source = readFileSync(mdAbs, 'utf8')
        const { html } = markdownToDist(mdRel, BASE)
        const includes = extractIncludes(source)
        let mermaidExpected = countMermaidBlocks(source)
        if (includes.length === 0 && mermaidExpected === 0) continue

        const article = articleOf(html, mdRel)
        if (article === null) continue
        const articleText = normalizeText(article.textContent)
        const headingTexts = article
            .querySelectorAll('h1, h2, h3, h4, h5, h6')
            .map((h) => normalizeText(h.textContent))

        for (const include of includes) {
            const where = `${mdRel} include ${include.raw}`
            const target = include.file.startsWith('@/')
                ? path.join(ROOT, include.file.slice(2))
                : path.resolve(path.dirname(mdAbs), include.file)
            if (!existsSync(target)) {
                fail(where, `source file not found (${path.relative(ROOT, target)})`)
                continue
            }
            includeSources.add(path.relative(REPO, target).split(path.sep).join('/'))
            const included = readFileSync(target, 'utf8')
            mermaidExpected += include.partial ? 0 : countMermaidBlocks(included)

            const markers =
                INCLUDE_MARKERS[include.raw] ??
                (include.partial ? undefined : deriveMarkers(included))
            if (markers === undefined) {
                fail(where, 'partial include needs explicit markers in INCLUDE_MARKERS')
                continue
            }
            if (markers.heading === undefined || markers.text === undefined) {
                fail(where, 'could not derive heading + text markers; add them to INCLUDE_MARKERS')
                continue
            }
            if (!headingTexts.includes(markers.heading)) {
                fail(where, `heading "${markers.heading}" not found in .vp-doc`)
            }
            if (!articleText.includes(markers.text)) {
                fail(where, `text "${markers.text.slice(0, 60)}" not found in .vp-doc`)
            }
        }

        const mermaidFound = article.querySelectorAll('.mermaid').length
        if (mermaidFound !== mermaidExpected) {
            fail(mdRel, `expected ${mermaidExpected} Mermaid container(s), found ${mermaidFound}`)
        }
    }
}

// T2.3: key article pages exist, have the expected h1 and enough text.
function checkKeyPages() {
    for (const { page, h1 } of KEY_PAGES) {
        const article = articleOf(markdownToDist(page, BASE).html, page)
        if (article === null) continue
        const firstH1 = article.querySelector('h1')
        if (firstH1 === null || normalizeText(firstH1.textContent) !== h1) {
            fail(page, `expected h1 "${h1}"`)
        }
        const chars = textWithoutHeadings(article).length
        if (chars < MIN_ARTICLE_CHARS) {
            fail(page, `article has ${chars} chars without headings, need ≥ ${MIN_ARTICLE_CHARS}`)
        }
    }
}

// T2.3a: home page hero (no .vp-doc on layout: home).
function checkHome() {
    const where = HOME.page
    const root = loadHtml(markdownToDist(HOME.page, BASE).html)
    if (root === null) return fail(where, 'missing in dist')
    const hero = root.querySelector('.VPHero')
    if (hero === null) return fail(where, 'no .VPHero')
    const name = normalizeText(hero.querySelector('.name')?.textContent ?? '')
    if (name !== HOME.name) fail(where, `hero name "${name}", expected "${HOME.name}"`)
    const tagline = normalizeText(hero.querySelector('.tagline')?.textContent ?? '')
    if (!tagline.includes(HOME.tagline)) fail(where, `hero tagline missing "${HOME.tagline}"`)
    const actions = hero.querySelectorAll('.actions a')
    if (actions.length === 0) fail(where, 'hero has no action links')
    // Action hrefs are validated by checkUrls like every other link.
}

// T2.4: every src/href/srcset in every page.
function checkUrls() {
    const htmlFiles = walk(DIST, (name) => name.endsWith('.html'))
    for (const abs of htmlFiles) {
        const rel = path.relative(DIST, abs).split(path.sep).join('/')
        if (rel === '404.html') continue
        const pageUrl = markdownToDist(rel.replace(/\.html$/, '.md'), BASE).urlPath
        const root = loadHtml(rel)
        const urls = []
        for (const el of root.querySelectorAll('[href], [src], [srcset]')) {
            for (const attr of ['href', 'src']) {
                const value = el.getAttribute(attr)
                if (value !== undefined) urls.push(value)
            }
            const srcset = el.getAttribute('srcset')
            if (srcset !== undefined) urls.push(...srcsetUrls(srcset))
        }

        for (const url of urls) {
            if (classifyUrl(url) === 'skip') continue
            const where = `${rel} → ${url}`
            const resolved = resolveInternalUrl(url, pageUrl, BASE)
            if ('error' in resolved) {
                fail(where, resolved.error)
                continue
            }
            if (resolved.kind === 'asset') {
                if (!existsSync(path.join(DIST, resolved.file)))
                    fail(where, 'asset not found in dist')
                continue
            }
            const target = resolved.candidates.find((c) => existsSync(path.join(DIST, c)))
            if (target === undefined) {
                fail(where, `page not found (${resolved.candidates.join(' | ')})`)
                continue
            }
            if (
                resolved.hash !== '' &&
                loadHtml(target).querySelector(`[id="${resolved.hash}"]`) === null
            ) {
                fail(where, `anchor #${resolved.hash} not found in ${target}`)
            }
        }
    }
}

// T3.3: every include source must trigger the docs workflow, or the site goes stale silently.
function checkWorkflowPaths() {
    const where = path.relative(REPO, WORKFLOW)
    if (!existsSync(WORKFLOW)) return fail(where, 'workflow not found')
    const { pr, push } = workflowPaths(parseYaml(readFileSync(WORKFLOW, 'utf8')))
    for (const [trigger, patterns] of [
        ['pull_request', pr],
        ['push', push],
    ]) {
        if (patterns.length === 0) {
            fail(where, `on.${trigger}.paths is empty`)
            continue
        }
        for (const file of uncoveredPaths([...includeSources], patterns)) {
            fail(where, `include source ${file} is not covered by on.${trigger}.paths`)
        }
    }
}

if (!existsSync(DIST)) {
    console.error(`verify-dist: ${path.relative(ROOT, DIST)} not found — run docs:build first`)
    process.exit(1)
}

checkSources()
checkKeyPages()
checkHome()
checkUrls()
checkWorkflowPaths()

if (errors.length > 0) {
    console.error(`verify-dist: ${errors.length} problem(s)\n`)
    for (const e of errors) console.error(`  ✖ ${e}`)
    process.exit(1)
}
console.log('verify-dist: all checks passed')
