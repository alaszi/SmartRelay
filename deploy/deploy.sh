#!/usr/bin/env bash
# Runs ON THE VPS (invoked over SSH by .github/workflows/deploy.yml's workflow_dispatch, or by
# hand). Not meant to run from a developer machine or CI runner directly.
#
# MASTER_PLAN section 3: "ssh + docker compose pull/up + migrate". No image registry is wired up
# yet (that's a CI image-publish job someone still has to add, plus a registry to push to — an
# owner/infra decision, section 1), so this builds the images locally on the VPS from the checked-
# out source instead of pulling pre-built ones. Swapping to a registry later only means adding
# `image:` tags in docker-compose.prod.yml and replacing the `build` call below with `pull`.
set -euo pipefail

DEPLOY_DIR="${SMARTRELAY_DEPLOY_DIR:-/opt/smartrelay}"
COMPOSE_FILE="docker-compose.prod.yml"
BRANCH="${SMARTRELAY_DEPLOY_BRANCH:-main}"

cd "$DEPLOY_DIR"

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

if [ ! -f .env ]; then
  echo "==> ERROR: $DEPLOY_DIR/.env is missing. Copy .env.example, fill in real secrets, and re-run." >&2
  exit 1
fi

echo "==> Building images"
docker compose -f "$COMPOSE_FILE" build

echo "==> Starting Postgres and Redis first, so the migration step has something to connect to"
docker compose -f "$COMPOSE_FILE" up -d postgres redis
docker compose -f "$COMPOSE_FILE" run --rm migrate

echo "==> Starting the rest of the stack"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Waiting for api to report healthy"
for _ in $(seq 1 30); do
  status="$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Health}}' api 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    echo "==> api is healthy"
    break
  fi
  sleep 2
done

echo "==> Removing unused images (keeps the disk from filling up over repeated deploys)"
docker image prune -f >/dev/null

echo "==> Deploy complete"
