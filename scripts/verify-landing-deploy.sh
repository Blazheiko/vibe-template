#!/bin/bash
# Checks a deployed landing (packages/landing) from the outside, with curl only.
#
# Usage: scripts/verify-landing-deploy.sh [--allow-local] [--insecure] <landing origin> <app origin>
#   scripts/verify-landing-deploy.sh https://example.com https://app.example.com
#   scripts/verify-landing-deploy.sh --allow-local http://localhost:8080 http://localhost:3000
#
#   --allow-local  accept http and local addresses (the local compose stack); without it every
#                  published address must be a public https one, like LANDING_STRICT=true
#   --insecure     do not verify TLS certificates (a local proxy with its own CA)
#
# Checks: the locale pages /, /uk/, /pl/ answer 200 with HTML; an unknown path answers 404 with the
# landing's 404 page (not the home page with 200); the security headers; canonical, hreflang and
# og:url of each page on the landing origin; both buttons on the app origin; sitemap.xml and
# robots.txt; and that <app>/login answers 200. Exit code 1 lists every failed check.
set -uo pipefail

ALLOW_LOCAL=false
CURL_OPTS=(--silent --show-error --max-time 20)
while [ $# -gt 0 ]; do
    case "$1" in
        --allow-local) ALLOW_LOCAL=true; shift ;;
        --insecure) CURL_OPTS+=(--insecure); shift ;;
        -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
        --*) echo "Unknown option $1" >&2; exit 2 ;;
        *) break ;;
    esac
done
if [ $# -ne 2 ]; then
    echo "Usage: $0 [--allow-local] [--insecure] <landing origin> <app origin>" >&2
    exit 2
fi
SITE="${1%/}"
APP="${2%/}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
PASSED=0

ok() { PASSED=$((PASSED + 1)); }
fail() {
    FAILED=$((FAILED + 1))
    echo "FAIL $*"
}

# fetch <url> <name>: body in $WORK/<name>.body, headers in $WORK/<name>.headers; prints the status.
fetch() {
    local code
    # On a network error curl still writes 000 as the status.
    code="$(curl "${CURL_OPTS[@]}" --output "$WORK/$2.body" --dump-header "$WORK/$2.headers" \
        --write-out '%{http_code}' "$1" 2>"$WORK/$2.error")" || true
    touch "$WORK/$2.body" "$WORK/$2.headers"
    echo "${code:-000}"
}

header() { grep -i "^$1:" "$WORK/$2.headers" | tail -n 1 | cut -d: -f2- | sed -e 's/^ *//' -e 's/\r$//'; }

# Why an address cannot be published in production, or nothing (same rules as build/urls.ts).
address_problem() {
    [ "$ALLOW_LOCAL" = "true" ] && return 0
    case "$1" in
        https://*) ;;
        *) echo "must use https"; return 0 ;;
    esac
    local host="${1#https://}"
    host="${host%%/*}"
    host="${host%%:*}"
    case "$host" in
        localhost | 127.0.0.1 | 0.0.0.0 | *.localhost) echo "points to the local machine" ;;
        example | *.example | example.com | *.example.com | example.net | *.example.net | example.org | *.example.org)
            echo "is a placeholder domain (RFC 2606)" ;;
    esac
}

check_address() {
    local problem
    problem="$(address_problem "$2")"
    if [ -n "$problem" ]; then fail "$1: $2 $problem"; else ok; fi
}

expect_contains() {
    if grep -qF -- "$3" "$WORK/$2.body"; then ok; else fail "$1: no $3"; fi
}

for origin in "$SITE" "$APP"; do check_address "address" "$origin"; done

# The locale pages.
for entry in "en|/" "uk|/uk/" "pl|/pl/"; do
    lang="${entry%%|*}"
    path="${entry#*|}"
    name="page-$lang"
    status="$(fetch "$SITE$path" "$name")"
    if [ "$status" != "200" ]; then
        fail "$SITE$path answered $status, expected 200 ($(cat "$WORK/$name.error"))"
        continue
    fi
    ok
    case "$(header content-type "$name")" in
        text/html*) ok ;;
        *) fail "$SITE$path: Content-Type is $(header content-type "$name"), expected text/html" ;;
    esac
    expect_contains "$path" "$name" "<html lang=\"$lang\">"
    expect_contains "$path" "$name" "<link rel=\"canonical\" href=\"$SITE$path\" />"
    expect_contains "$path" "$name" "<meta property=\"og:url\" content=\"$SITE$path\" />"
    for alt in "en|/" "uk|/uk/" "pl|/pl/" "x-default|/"; do
        expect_contains "$path" "$name" \
            "<link rel=\"alternate\" hreflang=\"${alt%%|*}\" href=\"$SITE${alt#*|}\" />"
    done
    expect_contains "$path" "$name" "href=\"$APP/login\" data-testid=\"cta-login\""
    expect_contains "$path" "$name" "href=\"$APP/register\" data-testid=\"cta-register\""
    if grep -q '<script' "$WORK/$name.body"; then fail "$path: has <script>"; else ok; fi
    for h in content-security-policy x-content-type-options referrer-policy; do
        if [ -n "$(header "$h" "$name")" ]; then ok; else fail "$path: no $h header"; fi
    done
    # Every address the page publishes follows the production rules.
    while IFS= read -r address; do
        check_address "$path" "$address"
    done < <(grep -oE '(href|content)="https?://[^"]*"' "$WORK/$name.body" |
        sed -E 's/^(href|content)="//; s/"$//' |
        grep -E "^(${SITE//./\\.}|${APP//./\\.})" | sort -u)
done

# An unknown path is the 404 page with 404, not the home page with 200.
status="$(fetch "$SITE/no-such-page-$RANDOM" not-found)"
if [ "$status" = "404" ]; then ok; else fail "an unknown path answered $status, expected 404"; fi
expect_contains "unknown path" not-found 'data-page="not-found"'

# Sitemap and robots.
status="$(fetch "$SITE/sitemap.xml" sitemap)"
if [ "$status" = "200" ]; then ok; else fail "sitemap.xml answered $status"; fi
locs="$(grep -oE '<loc>[^<]*</loc>' "$WORK/sitemap.body" | sed -E 's#</?loc>##g' | tr '\n' ' ')"
if [ "$locs" = "$SITE/ $SITE/uk/ $SITE/pl/ " ]; then ok; else fail "sitemap.xml lists: $locs"; fi
status="$(fetch "$SITE/robots.txt" robots)"
if [ "$status" = "200" ]; then ok; else fail "robots.txt answered $status"; fi
expect_contains "robots.txt" robots "Sitemap: $SITE/sitemap.xml"

# The app behind the buttons answers.
status="$(fetch "$APP/login" app-login)"
if [ "$status" = "200" ]; then ok; else fail "$APP/login answered $status, expected 200"; fi

echo
if [ "$FAILED" -gt 0 ]; then
    echo "verify-landing-deploy: $FAILED failed, $PASSED passed ($SITE -> $APP)"
    exit 1
fi
echo "verify-landing-deploy: all $PASSED checks passed ($SITE -> $APP)"
