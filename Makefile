.DEFAULT_GOAL := test

.PHONY: install build typecheck test check run docker-build docker-up

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

check: typecheck test build

run:
	npm run build
	npm start

docker-build:
	docker build -t standalone-google-lens-api:local .

docker-up:
	docker compose up --build
