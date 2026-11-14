# Single entry point for developer operations.
#
# Every target only delegates to a pnpm script or a script in scripts/; the logic lives
# there, so each target has a pnpm equivalent (see the docs: Make commands). `make` with no target prints the list below. Extra arguments go through ARGS,
# for example: make db-seed ARGS=--demo, make test-e2e ARGS="--project=chromium".
# One package: make test PKG=backend.
#
# Kept compatible with GNU Make 3.81 (the macOS default): no .ONESHELL, no grouped targets.
# A target is listed in `make help` when its line ends with `## description`; `##@ Name`
# starts a group. scripts/verify-makefile.mjs checks both and runs as part of `make check`.

.DEFAULT_GOAL := help
# Composite targets (check, init) rely on prerequisites running in order.
.NOTPARALLEL:

PNPM ?= pnpm
PKG ?=
ARGS ?=
ENV_FILE := packages/backend/.env

.PHONY: help setup init doctor install env build-shared \
	dev dev-backend dev-frontend dev-landing dev-playground prod-local start \
	check verify-makefile verify-compose check-bundle-graph typecheck lint lint-fix format format-check \
	test test-e2e test-e2e-landing test-pg test-redis coverage \
	services-up services-down \
	db-create db-migrate db-generate db-seed db-studio \
	app-build app-up app-down app-seed app-logs \
	docs-dev docs-build docs-preview docs-verify \
	build build-landing preview-landing clean

##@ Start

help: ## Show this list
	@awk 'BEGIN { FS = ":.*## " } \
		/^##@ / { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-z0-9-]+:.*## / { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ''
	@echo 'Options: PKG=<package> for test, ARGS="..." passed to the underlying script.'

setup: doctor install env build-shared ## First run: check tools, install deps, create .env, build shared

init: install build-shared check build ## Session start for agents (init.sh): install, check, build

doctor: ## Check Node, pnpm, Docker and .env
	@sh scripts/doctor.sh

install: ## Install workspace dependencies
	$(PNPM) install $(ARGS)

env: ## Create packages/backend/.env from .env.example if it is missing
	@if [ -f $(ENV_FILE) ]; then \
		echo '$(ENV_FILE) already exists, left as is'; \
	else \
		cp $(ENV_FILE).example $(ENV_FILE) && \
		echo 'Created $(ENV_FILE) from .env.example, review it before the first run'; \
	fi

build-shared: ## Build the shared package (typecheck and tests import it)
	$(PNPM) build:shared

##@ Development

dev: ## Backend, frontend and landing dev servers
	$(PNPM) dev

dev-backend: ## Backend dev server only
	$(PNPM) dev:backend

dev-frontend: ## Frontend dev server only
	$(PNPM) dev:frontend

dev-landing: ## Landing dev server only (http://localhost:5175)
	$(PNPM) dev:landing

dev-playground: ## Backend and API Playground
	$(PNPM) dev:manual_test

prod-local: ## Production-like local run: backend serves the built SPA, plus the landing
	$(PNPM) prod:local $(ARGS)

start: ## Start the built backend
	$(PNPM) start

##@ Quality

check: build-shared verify-makefile verify-compose format-check typecheck lint check-bundle-graph test ## Everything the CI quality job checks

verify-makefile: ## Check that Makefile targets are described and call existing scripts
	@node scripts/verify-makefile.mjs

verify-compose: ## Check that compose runs the app with the API prefix the image is built for
	@node scripts/verify-compose.mjs

check-bundle-graph: ## Frontend bundle carries no validation schema (ADR 0005)
	$(PNPM) check:bundle-graph

typecheck: ## TypeScript checks in every package
	$(PNPM) typecheck

lint: ## ESLint for the whole repository
	$(PNPM) lint

lint-fix: ## ESLint with --fix
	$(PNPM) lint:fix

format: ## Write Prettier formatting
	$(PNPM) format

format-check: ## Check Prettier formatting
	$(PNPM) format:check

##@ Tests

test: ## Unit tests (PKG=backend for one package)
	$(PNPM) $(if $(PKG),--filter $(PKG) )test $(ARGS)

test-e2e: ## Playwright e2e for the frontend
	$(PNPM) --filter frontend test:e2e $(ARGS)

test-e2e-landing: ## Build the landing and run its Playwright smoke tests
	$(PNPM) build:landing
	$(PNPM) --filter landing test:e2e $(ARGS)

test-pg: ## Backend PostgreSQL integration tests (needs services-up)
	$(PNPM) --filter backend test:pg $(ARGS)

test-redis: ## Backend Redis integration tests (needs services-up)
	$(PNPM) --filter backend test:redis $(ARGS)

coverage: ## Backend and frontend tests with coverage, as in CI
	$(PNPM) --filter backend test:coverage
	$(PNPM) --filter frontend test:coverage

##@ Services (Docker Compose)

services-up: ## Start PostgreSQL, Redis, S3 and Mailpit (ARGS="redis s3 mailpit" for a subset)
	$(PNPM) services:up $(ARGS)

services-down: ## Stop services and the app, keep the data
	$(PNPM) services:down

##@ Database

db-create: ## Create the database and the vector extension
	$(PNPM) --filter backend db:create

db-migrate: ## Apply Drizzle migrations
	$(PNPM) --filter backend db:migrate

db-generate: ## Generate a migration from the schema
	$(PNPM) --filter backend db:generate $(ARGS)

db-seed: ## Seed reference data (ARGS=--demo for demo accounts)
	$(PNPM) --filter backend db:seed $(ARGS)

db-studio: ## Open Drizzle Studio
	$(PNPM) --filter backend db:studio

##@ App in Docker

app-build: ## Build the app and landing images (vibe-template:local, vibe-template-landing:local)
	$(PNPM) app:build $(ARGS)

app-up: ## Services, migrations, the app and the landing, wait until healthy
	$(PNPM) app:up

app-down: ## Stop and remove only the app containers, keep services running
	$(PNPM) app:down

app-seed: ## Seed the app database with demo accounts
	$(PNPM) app:seed

app-logs: ## Follow the app and landing logs
	$(PNPM) app:logs

##@ Documentation

docs-dev: ## VitePress dev server
	$(PNPM) docs:dev

docs-build: ## Build the documentation site
	$(PNPM) docs:build

docs-preview: ## Preview the built documentation site
	$(PNPM) docs:preview

docs-verify: ## Check the built site (links, anchors, key pages)
	$(PNPM) docs:verify

##@ Build and clean

build: ## Build every package
	$(PNPM) build

build-landing: ## Build the landing into packages/landing/dist
	$(PNPM) build:landing

preview-landing: ## Serve the built landing (http://localhost:4174)
	$(PNPM) preview:landing

clean: ## Remove build output and node_modules
	$(PNPM) clean
