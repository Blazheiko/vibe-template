#!/bin/bash
# Checks a deployed landing (packages/landing) from the outside, with curl only.
#
# Usage: scripts/verify-landing-deploy.sh [options] <landing origin> <app origin>
#   scripts/verify-landing-deploy.sh https://example.com https://app.example.com
#   scripts/verify-landing-deploy.sh --allow-local http://localhost:8080 http://localhost:3000
#
#   --allow-local  accept http and local addresses (the local compose stack); without it every
#                  published address must be a public https one, like LANDING_STRICT=true
#   --insecure     do not verify TLS certificates (a local proxy with its own CA)
#   --check-address URL
#                  print why URL cannot be a production address ("ok" when it can) and exit
#   --resolve HOST:PORT:ADDR
#                  send requests for HOST:PORT to ADDR (curl --resolve, repeatable): check a new
#                  server before DNS points at it
#
# Checks: the locale pages /, /uk/, /pl/ answer 200 with HTML; an unknown path answers 404 with
# the landing's 404 page (not the home page with 200); the security headers; canonical, hreflang,
# og:url and og:image of each page on the landing origin; both buttons on the app origin;
# sitemap.xml and robots.txt; and that <app>/login answers 200. Every address a page publishes
# follows the production rules, whatever its origin. Exit code 1 lists every failed check.
set -uo pipefail

ALLOW_LOCAL=false
CHECK_ADDRESS=""
CURL_OPTS=(--silent --show-error --max-time 20)
while [ $# -gt 0 ]; do
    case "$1" in
        --allow-local) ALLOW_LOCAL=true; shift ;;
        --insecure) CURL_OPTS+=(--insecure); shift ;;
        --check-address)
            # One address through the rule only, for the shared test table.
            [ $# -ge 2 ] || { echo "--check-address needs a URL" >&2; exit 2; }
            CHECK_ADDRESS="$2"
            shift 2
            ;;
        --resolve)
            [ $# -ge 2 ] || { echo "--resolve needs HOST:PORT:ADDR" >&2; exit 2; }
            CURL_OPTS+=(--resolve "$2")
            shift 2
            ;;
        -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
        --*) echo "Unknown option $1" >&2; exit 2 ;;
        *) break ;;
    esac
done
# Why an address cannot be published in production, or nothing. The same rule, step by step and
# message by message, as productionProblem in packages/landing/build/urls.ts: a shell cannot
# normalize hosts the way a URL parser does (2130706433 and local%68ost are both localhost to a
# browser), so both refuse anything but a host written as a plain ASCII domain name.
# packages/landing/build/__tests__/address-rule.spec.ts runs one case table through both.
production_problem() {
    local url="$1" rest authority host port last
    case "$url" in
        *[[:space:][:cntrl:]\\]*) echo "is not a plain URL"; return 0 ;;
    esac
    case "$(printf '%s' "${url:0:8}" | tr '[:upper:]' '[:lower:]')" in
        https://) ;;
        *) echo "must use https"; return 0 ;;
    esac
    rest="${url:8}"
    authority="${rest%%[/?#]*}"
    authority="${authority##*@}"
    port=""
    if [ "${authority:0:1}" = "[" ]; then
        host="${authority%%]*}]"
        case "$authority" in *"]:"*) port="${authority#*]:}" ;; esac
    else
        host="${authority%%:*}"
        case "$authority" in *:*) port="${authority#*:}" ;; esac
    fi
    host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
    # A trailing dot is the same DNS name: example.com. is example.com.
    while [ "${host%.}" != "$host" ]; do host="${host%.}"; done
    if [ -z "$host" ]; then echo "has no host"; return 0; fi
    if [ -n "$port" ] && ! { [[ "$port" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$port))" -le 65535 ]; }; then
        echo "has an invalid port"; return 0
    fi
    if [ "${host:0:1}" = "[" ]; then echo "is an IP address, not a domain name"; return 0; fi
    if ! [[ "$host" =~ ^[a-z0-9.-]+$ ]]; then echo "is not a plain ASCII domain name"; return 0; fi
    # A URL parser reads a host whose last label is a number as IPv4 (127.1, 2130706433, 0x7f000001).
    last="${host##*.}"
    if [[ "$last" =~ ^[0-9]+$ ]] || [[ "$last" =~ ^0x[0-9a-f]*$ ]]; then
        echo "is an IP address, not a domain name"; return 0
    fi
    case "$host" in
        localhost | *.localhost) echo "points to the local machine" ;;
        example | *.example | example.com | *.example.com | example.net | *.example.net | \
            example.org | *.example.org | test | *.test | invalid | *.invalid)
            echo "is a placeholder domain (RFC 2606)" ;;
    esac
}

address_problem() {
    [ "$ALLOW_LOCAL" = "true" ] && return 0
    production_problem "$1"
}

if [ -n "$CHECK_ADDRESS" ]; then
    problem="$(production_problem "$CHECK_ADDRESS")"
    echo "${problem:-ok}"
    exit 0
fi
if [ $# -ne 2 ]; then
    echo "Usage: $0 [--allow-local] [--insecure] [--resolve HOST:PORT:ADDR] <landing origin> <app origin>" >&2
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

check_address() {
    local problem
    problem="$(address_problem "$2")"
    if [ -n "$problem" ]; then fail "$1: $2 $problem"; else ok; fi
}

# The addresses a page publishes: canonical and hreflang links, og:url and og:image, both
# buttons. Read from the tags themselves, one per line.
published_addresses() {
    {
        grep -oE '<link [^>]*rel="(canonical|alternate)"[^>]*>' "$1" | attribute href
        grep -oE '<meta [^>]*property="og:(url|image)"[^>]*>' "$1" | attribute content
        grep -oE '<a [^>]*data-testid="cta-(login|register)"[^>]*>' "$1" | attribute href
    } | sort -u
}

# attribute <name>: the value of that attribute of each tag on stdin.
attribute() { sed -nE "s/.* $1=\"([^\"]*)\".*/\1/p"; }

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
    expect_contains "$path" "$name" "<meta property=\"og:image\" content=\"$SITE/og-image.png\" />"
    # Every address the page publishes follows the production rules, whatever its origin: a
    # stray og:image on another host must fail too, so nothing is filtered out before the check.
    while IFS= read -r address; do
        check_address "$path" "$address"
    done < <(published_addresses "$WORK/$name.body")
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
