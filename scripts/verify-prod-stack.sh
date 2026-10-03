#!/usr/bin/env bash
# Smoke test for the production stack, run locally (needs Docker and free ports 80/443).
#
#   scripts/verify-prod-stack.sh
#
# Builds the three images (SKIP_BUILD=1 reuses existing clausecite-*:local), boots the whole
# docker-compose.prod.yml stack as the separate project "clausecite-prod-smoke" on DOMAIN=localhost
# (Caddy's internal CA, hence curl -k), checks it end to end, then tears it down and deletes the
# throwaway env file. It makes no paid model calls: it only hits /health, /, /auth/guest and
# /auth/login. The real OPENROUTER_API_KEY is copied from .env without being printed.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=clausecite-prod-smoke
ENV_FILE=.env.prod.local
BASE=https://localhost
TIMEOUT=${SMOKE_TIMEOUT:-120}
ADMIN_EMAIL=admin@smoke.local
BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/clausecite-smoke-backups.XXXXXX")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/clausecite-smoke.XXXXXX")

compose() {
  GHCR_OWNER=local IMAGE_TAG=local ENV_FILE="$ENV_FILE" BACKUP_DIR="$BACKUP_DIR" \
    docker compose -p "$PROJECT" -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"
}

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 && -f $ENV_FILE ]]; then
    echo "--- smoke test failed (exit $rc); container state and recent logs:" >&2
    compose ps -a >&2 || true
    compose logs --no-color --tail 40 >&2 || true
  fi
  if [[ -f $ENV_FILE ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_FILE"
  rm -rf "$BACKUP_DIR" "$WORK"
  exit "$rc"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null || fail "docker is not installed"
command -v openssl >/dev/null || fail "openssl is not installed"

# --- images: built as :local, then given the name the compose file expects (ghcr.io/local/...) ---
if [[ ${SKIP_BUILD:-0} != 1 ]]; then
  docker build -q -f docker/node-app.Dockerfile --build-arg APP=api -t clausecite-api:local . >/dev/null
  docker build -q -f docker/node-app.Dockerfile --build-arg APP=worker -t clausecite-worker:local . >/dev/null
  docker build -q -f docker/web.Dockerfile -t clausecite-web:local . >/dev/null
fi
for svc in api worker web; do
  docker image inspect "clausecite-$svc:local" >/dev/null 2>&1 || fail "image clausecite-$svc:local is missing"
  docker tag "clausecite-$svc:local" "ghcr.io/local/clausecite-$svc:local"
done

# --- throwaway env: random secrets, DOMAIN=localhost, the real OpenRouter key from .env ---
[[ -f .env ]] || fail ".env not found (needed only for OPENROUTER_API_KEY)"
openrouter_key=$(grep -E '^OPENROUTER_API_KEY=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"'"'" || true)
[[ -n $openrouter_key ]] || fail "OPENROUTER_API_KEY is empty in .env"
admin_password=$(openssl rand -hex 16)

umask 077
{
  echo "GHCR_OWNER=local"
  echo "IMAGE_TAG=local"
  echo "DOMAIN=localhost"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "RABBITMQ_USER=clausecite"
  echo "RABBITMQ_PASSWORD=$(openssl rand -hex 24)"
  echo "OPENROUTER_API_KEY=$openrouter_key"
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "ADMIN_EMAIL=$ADMIN_EMAIL"
  echo "ADMIN_PASSWORD=$admin_password"
} >"$ENV_FILE"
unset openrouter_key

# --- start from a clean slate, and make sure Caddy can bind 80/443 ---
compose down -v --remove-orphans >/dev/null 2>&1 || true
for port in 80 443; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    fail "port $port is already in use on this machine; stop what is listening on it and retry"
  fi
done

echo "starting the stack..."
compose up -d --quiet-pull >/dev/null

# --- wait for /api/health to answer 200 ---
echo "waiting up to ${TIMEOUT}s for $BASE/api/health..."
deadline=$((SECONDS + TIMEOUT))
code=000
while ((SECONDS < deadline)); do
  code=$(curl -sk --max-time 5 -o "$WORK/health.json" -w '%{http_code}' "$BASE/api/health" || true)
  [[ $code == 200 ]] && break
  sleep 3
done
[[ $code == 200 ]] || fail "/api/health did not return 200 within ${TIMEOUT}s (last status $code)"
for check in db redis rabbitmq; do
  grep -q "\"$check\":true" "$WORK/health.json" || fail "/api/health: $check is not true: $(cat "$WORK/health.json")"
done
echo "ok   /api/health 200, db/redis/rabbitmq true"

# The migrate job must have really run (a symlinked entry point once made it exit 0 having done nothing).
compose logs --no-color migrate 2>&1 | grep -q 'migrations applied' || fail "the migrate service did not apply migrations"
echo "ok   migrate service applied the migrations"

# --- the web app, through Caddy ---
code=$(curl -sk --max-time 10 -D "$WORK/web.headers" -o "$WORK/web.html" -w '%{http_code}' "$BASE/")
[[ $code == 200 ]] || fail "GET / returned $code"
grep -q 'ClauseCite' "$WORK/web.html" || fail "GET / does not contain ClauseCite"
echo "ok   GET / 200, HTML contains ClauseCite"

grep -qi '^content-security-policy:.*frame-ancestors' "$WORK/web.headers" || fail "GET / has no Content-Security-Policy"
grep -qi '^strict-transport-security:' "$WORK/web.headers" || fail "GET / has no Strict-Transport-Security"
if grep -qi '^server:' "$WORK/web.headers"; then fail "GET / still sends a Server header"; fi
echo "ok   GET / sends CSP and HSTS and no Server header"

# --- the API, through Caddy (the /api prefix is stripped) ---
code=$(curl -sk --max-time 10 -X POST -o "$WORK/guest.json" -w '%{http_code}' "$BASE/api/auth/guest")
[[ $code == 201 ]] || fail "POST /api/auth/guest returned $code"
grep -q '"token"' "$WORK/guest.json" || fail "POST /api/auth/guest returned no token"
echo "ok   POST /api/auth/guest 201 with a token"

# The admin is seeded from ADMIN_EMAIL/ADMIN_PASSWORD, so this proves env_file reached the api container.
code=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$admin_password" |
  curl -sk --max-time 10 -X POST -H 'Content-Type: application/json' --data @- \
    -o "$WORK/login.json" -w '%{http_code}' "$BASE/api/auth/login")
[[ $code == 200 ]] || fail "POST /api/auth/login (seeded admin) returned $code"
echo "ok   seeded admin can log in"

# --- the web container must not see any server secret ---
if compose exec -T web env | grep -qE 'OPENROUTER|JWT_SECRET|PASSWORD|DATABASE_URL'; then
  fail "the web container's environment holds a server secret"
fi
echo "ok   web container environment holds no secrets"

# --- the backup service writes its first dump straight away ---
deadline=$((SECONDS + 30))
until compgen -G "$BACKUP_DIR/clausecite-*.dump" >/dev/null && [[ -s $(ls "$BACKUP_DIR"/clausecite-*.dump | head -n 1) ]]; do
  ((SECONDS < deadline)) || fail "the backup service wrote no dump within 30s"
  sleep 2
done
echo "ok   backup service wrote a pg_dump"

echo "prod stack OK"
