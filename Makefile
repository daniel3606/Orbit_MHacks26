# Orbit developer commands. Run `nvm use` first (reads .nvmrc → Node 24.15).
# The spacetime CLI installs to ~/.local/bin.

export PATH := $(HOME)/.local/bin:$(PATH)
export LANG := en_US.UTF-8
export LC_ALL := en_US.UTF-8

DB ?= orbit-dev
SIM ?= iPhone 17 Pro

.PHONY: help check-node install stdb-start publish generate worker-identity api worker \
        mobile-ios mobile-start test test-spacetime test-backend typecheck check

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

check-node:
	@node -e 'const [M,m]=process.versions.node.split(".").map(Number); if (M<22||(M===22&&m<13)) { console.error("Node >= 22.13 required (run: nvm use)"); process.exit(1) }'

install: check-node ## Install all dependencies from lockfiles
	cd spacetime/spacetimedb && npm ci
	cd spacetime/tests && npm ci
	cd backend && uv sync
	cd mobile && npm ci

stdb-start: ## Start the local SpacetimeDB server (foreground, port 3000)
	spacetime start

publish: ## Build + publish the module to the local server as $(DB)
	cd spacetime && spacetime publish $(DB) --server local --module-path ./spacetimedb --yes

generate: ## Regenerate TypeScript bindings for mobile and tests
	cd spacetime && spacetime generate --lang typescript --out-dir ../mobile/src/realtime/module_bindings --module-path ./spacetimedb --yes
	cd spacetime && spacetime generate --lang typescript --out-dir tests/module_bindings --module-path ./spacetimedb --yes

worker-identity: ## Create the worker's service identity and allowlist it (local only)
	cd backend && uv run python -m scripts.bootstrap_service_identity --grant

api: ## Run FastAPI on :8000
	cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

worker: ## Run the durable job worker
	cd backend && uv run python -m app.workers

mobile-ios: check-node ## Build the dev client and launch on the iOS simulator ($(SIM))
	cd mobile && npx expo run:ios --device "$(SIM)"

mobile-start: check-node ## Start Metro for an already-installed dev client
	cd mobile && npx expo start --dev-client

test-spacetime: check-node ## Republish orbit-test (wiped) and run realtime integration tests
	cd spacetime/tests && npm test

test-backend: ## Backend unit + integration tests (integration needs orbit-test)
	cd backend && uv run pytest -q

test: test-spacetime test-backend ## All automated tests

typecheck: check-node ## Type-check module, tests, mobile and backend
	cd spacetime/spacetimedb && npx tsc --noEmit -p .
	cd spacetime/tests && npx tsc --noEmit -p .
	cd mobile && npx tsc --noEmit
	cd mobile && CI=1 npx expo lint
	cd mobile && npm run --silent check:contract
	cd backend && uv run mypy

check: typecheck test ## Everything CI would run
