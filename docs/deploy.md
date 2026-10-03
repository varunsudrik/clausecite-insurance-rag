# Deploying ClauseCite

One VM runs the whole stack with Docker Compose (`docker-compose.prod.yml`): Caddy (automatic HTTPS) in front of the web app and the API, plus Postgres/pgvector, RabbitMQ, two Redis instances, the worker and a daily `pg_dump` backup job.

GitHub Actions does the rest. `ci.yml` runs on every push and pull request. When CI succeeds on `main`, `deploy.yml` builds the `api`, `worker` and `web` images, pushes them to GHCR tagged with the commit sha and `latest`, copies `docker-compose.prod.yml` and `docker/Caddyfile` to the server over SSH, pulls the three app images, runs `docker compose up -d`, waits for the app services (api, worker, web, Caddy), reloads Caddy so a changed `Caddyfile` takes effect, and finally polls `https://<domain>/api/health`. It does nothing until the repository variable `DEPLOY_ENABLED` is `true`.

Replace `<domain>` and `<server-ip>` below with your own values. The code blocks contain `#` comment lines: in zsh (the macOS default), run `setopt interactivecomments` first, or pasting them fails.

## 0. Cap your spend first (DECISIONS 012)

Create the OpenRouter key for this deployment and **set a credit limit on it when you create it** (openrouter.ai, Keys, Edit, Credit limit). Pick an amount you are happy to lose. It is the only spend bound that does not depend on application code: the daily token budgets in step 10 are a second line of defence, and they do not cover a chat that fails mid-generation.

## 1. Provision the server

- Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, at least 40 GB disk (for example Hetzner CX22, or a 4 GB Lightsail instance).
- It must be x86_64. The workflow builds `linux/amd64` images only. For an ARM server (Hetzner CAX), add `platforms: linux/amd64,linux/arm64` to the three build steps in `deploy.yml` and a `docker/setup-qemu-action` step before them.
- Create a non-root user that GitHub will deploy as, with your public key:

```bash
# as root
adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo 'ssh-ed25519 AAAA... you@laptop' >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
```

## 2. Point DNS at it

Create one `A` record for `<domain>` pointing at `<server-ip>`. **Do not add an `AAAA` record**, even if the server has an IPv6 address: Docker's default compose network is IPv4-only, so an IPv6 connection to a published port is proxied and Caddy sees the bridge gateway as the client. Every IPv6 visitor would then share one address in the per-IP rate limits (the guest-token limit alone is 5 per hour), and they would lock each other out. The stack is IPv4-only until [IPv6 (not yet supported)](#ipv6-not-yet-supported) is done.

Do not put a proxying CDN in front of Caddy either (for example Cloudflare with the orange cloud on, or any "proxied" record). Every client would then arrive from the CDN's edge addresses, so the per-IP limits would bucket visitors by edge, and `TRUST_PROXY_HOPS=1` (one proxy hop, Caddy) would be wrong. Use a DNS-only record.

Check it before the first deploy, because Caddy requests its Let's Encrypt certificate as soon as it starts:

```bash
# must print <server-ip>
dig +short <domain>
# must print nothing: there is no AAAA record
dig +short AAAA <domain>
```

## 3. Lock the server down

Only 22/tcp, 80/tcp, 443/tcp and 443/udp (HTTP/3) may be open, and SSH must accept keys only. Set the same rules in your provider's network firewall (Hetzner Firewall, Lightsail Networking), and on the host:

```bash
# as root, with your key already in /home/deploy/.ssh/authorized_keys
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-keys-only.conf
systemctl reload ssh

ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

`ufw` does not filter ports that Docker publishes. That is acceptable here because only Caddy publishes ports (80 and 443); Postgres, RabbitMQ and Redis stay on the private compose network. Do not add `ports:` to any other service.

## 4. Install Docker

Install Docker Engine with the Compose v2 plugin (the stack was verified with Compose v2.21):

```bash
# as root
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
docker compose version
```

`deploy` can now run `docker`, which is root-equivalent on this host: keep its key private.

## 5. Create the deploy directory and `.env.prod`

The workflow copies `docker-compose.prod.yml` and `docker/Caddyfile` into the deploy directory on every run. It never touches `.env.prod`, which lives only on the server and is never committed.

```bash
# as root
install -d -o deploy -g deploy /opt/clausecite

# from your laptop, in the repository
scp .env.prod.example deploy@<server-ip>:/opt/clausecite/.env.prod
ssh deploy@<server-ip> chmod 600 /opt/clausecite/.env.prod
```

Generate every secret as URL-safe hex. Several end up inside connection URLs, and Compose interpolates `$`, so base64 characters (`+ / =`) and `$` break things:

```bash
# POSTGRES_PASSWORD, RABBITMQ_PASSWORD
openssl rand -hex 24
# JWT_SECRET (the API refuses to start with fewer than 32 characters)
openssl rand -hex 32
# ADMIN_PASSWORD, if you want a generated one (at least 12 characters)
openssl rand -hex 16
```

Edit `/opt/clausecite/.env.prod` on the server and fill in every empty value (`.env.prod.example` documents each one):

- `GHCR_OWNER`: your GitHub user or organisation, in lowercase.
- `DOMAIN`: the public hostname from step 2.
- `OPENROUTER_API_KEY`: the key from step 0.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the admin account. It is created on first start only; editing these later does not change an existing admin.
- `GUEST_DAILY_TOKEN_BUDGET`, `GLOBAL_DAILY_TOKEN_BUDGET`: see step 10.
- Leave `IMAGE_TAG=latest`. The deploy workflow exports the commit sha over it for each rollout.

`POSTGRES_PASSWORD` only takes effect when the database is first created. Changing it afterwards means running `ALTER USER` inside Postgres as well.

## 6. Let the server pull from GHCR

GHCR packages are **private by default**, so an anonymous `docker compose pull` fails with `denied` or `unauthorized`. Choose one:

- **Keep them private (recommended).** Create a classic personal access token with only the `read:packages` scope (fine-grained tokens cannot read GHCR) and log in once as the deploy user:

  ```bash
  # as deploy on the server
  echo '<token>' | docker login ghcr.io -u <github-username> --password-stdin
  ```

  The credential is stored in `~/.docker/config.json`. Revoke the token if the server is ever compromised.

- **Make them public.** The images contain no secrets. The packages do not exist until the first deploy has pushed them, so the first run fails at `pull`; then open each of the three `clausecite-*` packages on GitHub, Package settings, Change visibility, Public, and re-run the workflow.

## 7. Configure GitHub

Merge `.github/workflows/` into `main` first: a `workflow_run` workflow only triggers from the default branch. Then create a dedicated deploy key (no passphrase, because the workflow runs non-interactively) and store everything with the `gh` CLI, or under Settings, Secrets and variables, Actions:

```bash
ssh-keygen -t ed25519 -N "" -C clausecite-deploy -f ./clausecite-deploy
ssh-copy-id -i ./clausecite-deploy.pub deploy@<server-ip>

# Pin the server's host key (see the note below). Use exactly the value you store in DEPLOY_HOST.
ssh-keyscan -t ed25519 <server-ip> > known_hosts.txt
# compare this fingerprint with the one printed on the server (use the provider's web console) by:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf known_hosts.txt

gh secret set DEPLOY_HOST --body '<server-ip>'
gh secret set DEPLOY_USER --body 'deploy'
gh secret set DEPLOY_SSH_KEY < ./clausecite-deploy
gh secret set DEPLOY_KNOWN_HOSTS < known_hosts.txt
gh variable set DOMAIN --body '<domain>'
# optional: /opt/clausecite is the default
gh variable set DEPLOY_PATH --body '/opt/clausecite'
rm ./clausecite-deploy ./clausecite-deploy.pub known_hosts.txt
```

| Name                 | Kind     | Purpose                                                                                       |
| -------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`        | secret   | server address (the value you ran `ssh-keyscan` against)                                      |
| `DEPLOY_USER`        | secret   | SSH user, `deploy` above                                                                      |
| `DEPLOY_SSH_KEY`     | secret   | private deploy key, the whole file including the `BEGIN`/`END` lines                          |
| `DEPLOY_KNOWN_HOSTS` | secret   | the server's host key line(s); strongly recommended                                           |
| `DOMAIN`             | variable | public hostname; the smoke test polls `https://<domain>/api/health`                           |
| `DEPLOY_PATH`        | variable | optional; absolute path, letters, digits and `. _ / -` only. Default `/opt/clausecite`        |
| `DEPLOY_ENABLED`     | variable | `true` switches deploys on; leave it unset until steps 1 to 6 are done                        |

**Host key.** With `DEPLOY_KNOWN_HOSTS` set, SSH runs with `StrictHostKeyChecking=yes` against exactly that key. Without it the workflow falls back to `ssh-keyscan` on every run and logs a warning: that is trust-on-first-use, and it cannot detect a man-in-the-middle at deploy time. If you rebuild the server, refresh the secret, or deploys fail with `Host key verification failed`.

## 8. First deploy

```bash
gh variable set DEPLOY_ENABLED --body true
# or push to main and let CI trigger it
gh workflow run deploy.yml --ref main
gh run watch
```

A manual run only deploys when it is started on `main`; on any other ref the job is skipped. That is accident protection, not a security boundary: anyone with write access can still change the workflow on a branch. A hard boundary needs a GitHub Environment with a deployment-branch policy and environment-scoped secrets (optional hardening). A manual run also deploys `main`'s current HEAD without checking that CI passed on it, so prefer letting the `workflow_run` path (CI succeeded on `main`) do the deploy.

- The remote step pulls only the `api`, `worker` and `web` images (so floating infrastructure tags such as Postgres are never swapped under you), runs `up -d --remove-orphans` to create or update everything, then waits up to 10 minutes for `api worker web caddy`. Only `api` and `web` have health checks; `worker` and `caddy` have none, so for them the wait only proves the container is running.
- A deploy never waits on `backup`, and nothing in it checks the backup either, so a stale or failing backup does not block a hotfix and does not alert you. Look at it yourself (step 11).
- After the wait the workflow runs `caddy reload`, which applies a changed `docker/Caddyfile` (a no-op if it is unchanged).
- The smoke step then polls `https://<domain>/api/health` for up to three minutes and passes only on HTTP 200. The first certificate is issued while it polls.
- Check by hand with `curl -fsS https://<domain>/api/health`, and open `https://<domain>` in a browser.

**Updating infrastructure images.** Deploys never pull Caddy, Postgres, RabbitMQ or Redis (their tags float), so a security release of one of them does not arrive on its own. To take it on purpose, pull that one service and recreate only it:

```bash
cd /opt/clausecite
docker compose -f docker-compose.prod.yml --env-file .env.prod pull caddy
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps caddy
```

Caddy keeps its certificates in the `caddy_data` volume. Recreating `postgres` restarts the database, so chat and search fail for a short while; the tag is `pg17`, so a pull brings minor releases only. Take a fresh backup first and copy it off-host (step 11), then, after the `up`, check `/api/health` and run `docker compose ... restart api worker` if they have not recovered:

```bash
(umask 077; docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backup pg_dump -Fc > pre-upgrade.dump)
docker compose -f docker-compose.prod.yml --env-file .env.prod pull postgres
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps postgres
```

## 9. Load the policies (first ingest)

Ingest from your laptop, not from the server. Do not run `pnpm sources:download` on the server: it re-downloads any PDF that is missing or whose hash differs from `data/sources.lock.json` and silently re-pins the lockfile to whatever the insurer serves today.

```bash
# on your laptop, in the repository
pnpm install
pnpm sources:download
# must print nothing: re-downloading unchanged bytes leaves the lock as it is,
# so any change means an insurer replaced a PDF (or data/sources.json changed)
git diff --stat data/sources.lock.json

# put the production ADMIN_EMAIL and ADMIN_PASSWORD (from .env.prod) in the git-ignored .env at the repo root,
# in place of the local dev values, then:
API_URL=https://<domain>/api pnpm sources:ingest
```

`sources:ingest` verifies each PDF against the lockfile hash before it uploads it, logs in as the admin, then waits until every document is `ready` or `failed` and prints a table. It exits non-zero if any document failed, and it refuses to send the admin credentials to a plain `http://` URL unless the host is `localhost`, `127.0.0.1` or `[::1]`. The script loads the git-ignored `.env` for `ADMIN_EMAIL` and `ADMIN_PASSWORD`; an `API_URL` given on the command line wins over one in `.env`. When you are done, put the dev values back so the production password does not stay on disk. Re-running is safe: documents already ingested are deduplicated.

## 10. Before a public demo (DECISIONS 012)

- [ ] **The OpenRouter key has a credit limit** (step 0). Do this before anything else on the list.
- [ ] `GUEST_DAILY_TOKEN_BUDGET` (default 50000 tokens per guest per day) and `GLOBAL_DAILY_TOKEN_BUDGET` (default 2000000 tokens per day for the whole deployment, admins included) are set to numbers you chose. When the global budget is spent, `/chat` and `/search` answer 429 until UTC midnight, and a Redis error rejects requests rather than letting them through (fail closed).
- [ ] `TRUST_PROXY_HOPS=1` in the API container. Compose sets it; confirm it, because with `0` every visitor would share Caddy's address in the per-IP limits:

  ```bash
  cd /opt/clausecite
  # must print 1
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec api printenv TRUST_PROXY_HOPS
  ```

- [ ] DNS has an `A` record and no `AAAA` record, and no proxying CDN sits in front of Caddy (step 2). The API must see each visitor's own address, not a Docker one. Nothing logs the client address (Caddy's access log is off and the API logs no requests), but the per-IP rate-limit counters in Redis are keyed by it, so use one:

  ```bash
  # from your laptop: forces IPv4, and spends one of your address's 5 guest tokens for this hour
  curl -4 -fsS -X POST -o /dev/null https://<domain>/api/auth/guest
  ```

  ```bash
  # on the server: must list rl:guestToken:ip:<your-public-ipv4>:<window-number>, never a 172.x or 10.x Docker address
  docker compose -f docker-compose.prod.yml --env-file .env.prod exec redis redis-cli --scan --pattern 'rl:guestToken:ip:*'
  ```

- [ ] The guest-token limit is tight for a shared demo. Each IP address gets 5 guest tokens per hour, so a roomful of visitors behind one office or event NAT shares them, and the sixth new visitor in that hour gets a 429. The value is a code constant, not an environment variable: `RATE_POLICIES.guestToken` in `apps/api/src/limits/policies.ts` (`{ ip: { limit: 5, windowSeconds: 3600 } }`). To raise it, change it there and deploy. Visitors who already hold a token (valid for 24 hours, kept in their browser) are not affected, so have people open the app once before the demo starts.
- [ ] The admin password is strong and not reused from anywhere else.
- [ ] Firewall as in step 3, and `docker compose ... ps` shows only Caddy with published ports.
- [ ] A dump exists off-host (step 11) and you have tried a restore at least once (step 12).

## 11. Backups

The `backup` service writes `/backups/clausecite-YYYY-MM-DD.dump` (a custom-format `pg_dump`, mode 600) every 24 hours and keeps 7 days. A dump is written to a temporary file and renamed into place only when it succeeded.

```bash
cd /opt/clausecite
docker compose -f docker-compose.prod.yml --env-file .env.prod logs --tail 20 backup
docker inspect --format '{{.State.Health.Status}}' clausecite-prod-backup-1
```

- `backup ok /backups/clausecite-2026-10-03.dump 123456` is a good run. `backup FAILED: pg_dump did not produce a dump; retrying in 300 s` (on stderr) is a failed one; it retries every five minutes and leaves the last good dump alone.
- The container's health is `healthy` while the newest dump exists, is non-empty and is under 26 hours old, `starting` until its first check passes (about five minutes after the container starts), and `unhealthy` otherwise. Nothing pages you, and a deploy neither waits on nor checks the backup: look at `docker compose ... ps backup` (it should say `healthy`) and the logs now and then, or alert on it.

**Dumps stay on the server and are not encrypted.** They are not in a Docker volume: the compose file bind-mounts `BACKUP_DIR`, by default `./backups`, which is `/opt/clausecite/backups`. The files are root-owned with mode 600, so a plain `scp` as `deploy` cannot read them. Copy them off-host with `docker cp` (no sudo needed), from your laptop or any machine that is always on:

```bash
ssh deploy@<server-ip> 'rm -rf ~/backups-out && docker cp clausecite-prod-backup-1:/backups/. ~/backups-out/'
rsync -a --remove-source-files deploy@<server-ip>:backups-out/ ./clausecite-backups/
```

If `deploy` has passwordless sudo, `rsync -a --rsync-path="sudo rsync" deploy@<server-ip>:/opt/clausecite/backups/ ./clausecite-backups/` does it in one step. Encrypt the copies before they go to shared storage (for example `gpg --symmetric --cipher-algo AES256 <file>`).

**The uploaded PDFs are not backed up by anything.** They live in the `pdfs` named volume, `clausecite-prod_pdfs` (the compose project name `clausecite-prod`, then `_pdfs`; confirm with `docker volume ls | grep clausecite-prod`). The database dump holds the chunks and metadata, but the PDFs behind the citations are only in that volume, so a database restore without the matching PDFs breaks citations: they point at files that are no longer there. Back the volume up alongside the dump:

```bash
docker run --rm -v clausecite-prod_pdfs:/d:ro -v "$PWD":/out alpine tar czf /out/pdfs-$(date +%F).tgz -C /d .
```

The policies in `data/sources.json` can always be re-ingested from your laptop (step 9); anything uploaded by hand cannot, so those PDFs are the ones this archive protects.

## 12. Restore

Stop the api and worker first, so nothing writes during the restore. On a rebuilt server, finish steps 1 to 8 first so that the schema exists, then restore over it. Read the sha that is running before you stop anything and keep it exported: `.env.prod` only holds `IMAGE_TAG=latest`, and `latest` may be a build that never went through a deploy. Put the dump where `deploy` can read it: `scp` your off-host copy to `/opt/clausecite/`, or for a dump that is still on the server run `docker cp clausecite-prod-backup-1:/backups/clausecite-2026-10-03.dump .` there.

```bash
cd /opt/clausecite
dc() { docker compose -f docker-compose.prod.yml --env-file .env.prod "$@"; }

# the commit sha currently deployed
export IMAGE_TAG=$(docker inspect --format '{{.Config.Image}}' clausecite-prod-api-1 | sed 's/.*://')
echo "$IMAGE_TAG"

dc stop api worker
dc cp ./clausecite-2026-10-03.dump postgres:/tmp/restore.dump
dc exec postgres pg_restore --clean --if-exists --no-owner -U clausecite -d clausecite /tmp/restore.dump
dc exec postgres rm /tmp/restore.dump
rm ./clausecite-2026-10-03.dump

# the PDFs from their archive, before the api starts again
docker run --rm -v clausecite-prod_pdfs:/d -v "$PWD":/in:ro alpine tar xzf /in/pdfs-2026-10-03.tgz -C /d

dc up -d
dc up -d --wait --wait-timeout 600 api worker web caddy
```

`echo "$IMAGE_TAG"` must print a 40-character sha; if it prints nothing, stop and find the sha (Actions, Deploy runs) before going on. The exported `IMAGE_TAG` pins both `up` commands to the deployed images. Open a citation afterwards to confirm the PDF renders. Try this once on a scratch server before you depend on it.

## 13. Day-2 operations

**Redeploy.** Push to `main` (CI then Deploy run on their own), or run the Deploy workflow on `main` by hand.

**Roll back.** Images stay in GHCR tagged by commit sha. On the server:

```bash
cd /opt/clausecite
export IMAGE_TAG=<older commit sha>
docker compose -f docker-compose.prod.yml --env-file .env.prod pull api worker web
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --remove-orphans
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --wait --wait-timeout 600 api worker web caddy
```

Migrations only move forward, so rolling back across one needs a database restore (step 12) as well. The next deploy moves the stack forward again.

**Change `.env.prod`.** Edit it on the server, then recreate api and worker. Export the sha that is running first: `.env.prod` only holds `IMAGE_TAG=latest`, and without the export the recreated containers would switch to `latest`. `--no-deps` leaves Postgres and the rest alone, and naming only `api worker` means the wait never involves `backup`:

```bash
cd /opt/clausecite
export IMAGE_TAG=$(docker inspect --format '{{.Config.Image}}' clausecite-prod-api-1 | sed 's/.*://')
# the commit sha currently deployed
echo "$IMAGE_TAG"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate --no-deps --wait --wait-timeout 600 api worker
```

**Change `EMBEDDING_MODEL`.** Chunks and queries must be embedded by the same model: after a change, searches compare new query vectors with old chunk vectors until every policy is re-embedded, and answers quietly get worse or refuse. Set it in `.env.prod`, recreate api and worker as in "Change `.env.prod`", then sign in as admin and press Re-ingest on every policy on the Policies page. The production images do not ship `scripts/`, so `pnpm reembed` is not a production path.

**Rotate `JWT_SECRET`.** Generate a new one with `openssl rand -hex 32`, put it in `.env.prod`, and recreate api and worker as in "Change `.env.prod`". There is no overlap period: every existing token stops verifying at once, which logs everyone out. The admin has to log in again, and guests are issued a fresh token on their next request.

**PgBouncer.** None is part of this stack, and a PgBouncer in transaction mode would break it: the API and worker connect with the `options` startup parameter (`-c hnsw.iterative_scan=relaxed_order`, set in `packages/core/src/db/client.ts`), which PgBouncer in transaction mode rejects. If you add a pooler, use session pooling, or set the parameter on the role instead and drop it from the client:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec postgres \
  psql -U clausecite -d clausecite -c "ALTER ROLE clausecite SET hnsw.iterative_scan = relaxed_order"
```

**Disk.** Every deploy leaves the previous images behind. Run `docker image prune -af --filter until=168h` now and then; it never removes an image a container is using. Each container's logs are capped at 3 files of 10 MB.

**Troubleshooting.**

- Deploy fails at `pull` with `denied`/`unauthorized`: step 6.
- The push fails with `permission_denied: write_package`: on the package's settings page, under Manage Actions access, add this repository with the Write role.
- The smoke test times out: check that DNS points at the server and that 80 and 443 are open, then read Caddy's log with `docker compose -f docker-compose.prod.yml --env-file .env.prod logs caddy`.
- `up --wait` reports an unhealthy service: `docker compose ... ps` and `docker compose ... logs <service>` on the server show which and why.

## IPv6 (not yet supported)

Production is IPv4-only. Docker's default compose network has no IPv6, so a connection that reaches a published port over IPv6 is relayed by Docker's userland proxy and arrives at Caddy from the bridge gateway instead of the visitor's address. `X-Forwarded-For`, and with it `req.ip` and every per-IP limit, would then hold the gateway for all IPv6 visitors. That is why step 2 allows an `A` record only.

Supporting IPv6 needs more than a DNS record: the compose network needs `enable_ipv6: true` (with an IPv6 subnet), and Docker Engine 27 or later needs `ip6tables` enabled, so that published ports are DNAT-ed and keep the client address. The API already buckets IPv6 clients by /64, so the limits are ready for it. None of this has been verified on this stack. Before adding an `AAAA` record, make an IPv6 request to the server (`curl -6 --resolve '<domain>:443:[<server-ipv6>]' -X POST -o /dev/null https://<domain>/api/auth/guest`) and run the Redis check from step 10: the key must contain your own /64, for example `rl:guestToken:ip:2001:db8:abcd:12::/64:<window-number>`, never a Docker address.
