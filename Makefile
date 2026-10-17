.DEFAULT_GOAL := test

.PHONY: install build typecheck python-typecheck test python-test audit check run docker-build docker-build-worker docker-up

install:
	npm ci
	uv sync --locked --extra dev

build:
	npm run build

typecheck:
	npm run typecheck

python-typecheck:
	uv run mypy scrapling_worker
	uv lock --check
	uv pip check

test:
	npm test
	uv run pytest -q

python-test:
	uv run pytest -q

audit:
	npm audit --omit=dev

check: typecheck python-typecheck test audit build

run:
	npm run build
	npm start

docker-build:
	docker build -t standalone-google-lens-api:local .

docker-build-worker:
	docker build -f Dockerfile.scrapling-worker -t standalone-google-lens-scrapling-worker:local .

docker-up:
	docker compose up --build
