#!/bin/sh
set -e

BUILD_MODE="${LOCAL_DOCKER_BUILD_MODE:-auto}"
BOOTSTRAP_MODE="${LOCAL_DOCKER_BOOTSTRAP_MODE:-once}"
BOOTSTRAP_STATE_DIR="${LOCAL_DOCKER_BOOTSTRAP_STATE_DIR:-/usr/src/app/.docker-local-state}"
BOOTSTRAP_SENTINEL="${BOOTSTRAP_STATE_DIR}/backend-bootstrap-complete"
BUILD_HASH_FILE="${BOOTSTRAP_STATE_DIR}/backend-build-inputs.sha256"
DIST_SERVER_ENTRY="/usr/src/app/dist/server.js"

compute_build_input_hash() {
  node <<'NODE'
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const buildInputs = [
  "src",
  "prisma",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "nest-cli.json",
  "webpack.config.js",
];

const hash = createHash("sha256");

function addPath(entry) {
  const stat = statSync(entry);

  if (stat.isDirectory()) {
    const children = readdirSync(entry).sort((left, right) => left.localeCompare(right));

    for (const child of children) {
      addPath(path.join(entry, child));
    }

    return;
  }

  hash.update(entry);
  hash.update("\0");
  hash.update(readFileSync(entry));
  hash.update("\0");
}

for (const entry of buildInputs) {
  if (existsSync(entry)) {
    addPath(entry);
  }
}

process.stdout.write(hash.digest("hex"));
NODE
}

build_backend() {
  echo "=== Building backend ==="
  mkdir -p /usr/src/app/dist
  find /usr/src/app/dist -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  NODE_OPTIONS=--experimental-global-webcrypto pnpm exec webpack --mode production
}

ensure_backend_build() {
  mkdir -p "$BOOTSTRAP_STATE_DIR"

  case "$BUILD_MODE" in
    always)
      echo "=== Rebuilding backend on every start (LOCAL_DOCKER_BUILD_MODE=always) ==="
      build_backend
      compute_build_input_hash > "$BUILD_HASH_FILE"
      ;;
    never)
      if [ ! -f "$DIST_SERVER_ENTRY" ]; then
        echo "LOCAL_DOCKER_BUILD_MODE=never but $DIST_SERVER_ENTRY is missing"
        exit 1
      fi

      echo "=== Skipping backend build (LOCAL_DOCKER_BUILD_MODE=never) ==="
      ;;
    auto)
      CURRENT_BUILD_HASH="$(compute_build_input_hash)"
      PREVIOUS_BUILD_HASH=""

      if [ -f "$BUILD_HASH_FILE" ]; then
        PREVIOUS_BUILD_HASH="$(cat "$BUILD_HASH_FILE")"
      fi

      if [ -f "$DIST_SERVER_ENTRY" ] && [ "$CURRENT_BUILD_HASH" = "$PREVIOUS_BUILD_HASH" ]; then
        echo "=== Skipping backend build; cached dist matches current source ==="
      else
        echo "=== Backend build cache miss; recompiling ==="
        build_backend
        printf '%s' "$CURRENT_BUILD_HASH" > "$BUILD_HASH_FILE"
      fi
      ;;
    *)
      echo "Unsupported LOCAL_DOCKER_BUILD_MODE: $BUILD_MODE"
      exit 1
      ;;
  esac
}

run_local_bootstrap() {
  echo "=== Seeding database ==="
  npx prisma db seed || echo "Seeding completed (or already seeded)"

  echo "=== Seeding local test users ==="
  npx ts-node prisma/scripts/create-tier-users.ts || echo "Test user seeding completed (or already seeded)"

  echo "=== Setting up income review test user ==="
  npx ts-node prisma/scripts/setup-income-review-test-user.ts || echo "Income review test user setup completed"

  echo "=== Setting up 2FA test user ==="
  npx ts-node prisma/scripts/setup-2fa-test-user.ts || echo "2FA test user setup completed"

  echo "=== Provisioning Quidax sub-accounts and wallets for local test users ==="
  npx ts-node prisma/scripts/setup-local-quidax-test-users.ts || echo "Local Quidax test-user provisioning completed (or skipped/partially failed)"
}

ensure_backend_build

echo "=== Applying database migrations ==="
npx prisma migrate deploy

case "$BOOTSTRAP_MODE" in
  always)
    echo "=== Running local bootstrap on every start (LOCAL_DOCKER_BOOTSTRAP_MODE=always) ==="
    run_local_bootstrap
    date -u > "$BOOTSTRAP_SENTINEL"
    ;;
  never)
    echo "=== Skipping local bootstrap (LOCAL_DOCKER_BOOTSTRAP_MODE=never) ==="
    ;;
  once)
    if [ -f "$BOOTSTRAP_SENTINEL" ]; then
      echo "=== Skipping local bootstrap; sentinel found at $BOOTSTRAP_SENTINEL ==="
    else
      echo "=== Running one-time local bootstrap ==="
      run_local_bootstrap
      date -u > "$BOOTSTRAP_SENTINEL"
    fi
    ;;
  *)
    echo "Unsupported LOCAL_DOCKER_BOOTSTRAP_MODE: $BOOTSTRAP_MODE"
    exit 1
    ;;
esac

echo "=== Starting server ==="
exec node dist/server