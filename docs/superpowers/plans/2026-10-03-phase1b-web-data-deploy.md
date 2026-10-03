# ClauseCite Phase 1B — Web UI, Real Policy Data, Spend Gates, Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1A backend into a demo-able product. This plan:
- hardens the API for public exposure (DECISIONS 011/012)
- ships the Next.js chat UI with citation panel and PDF viewer
- ingests ~10 real public policy wordings
- packages everything into containers with CI and an SSH deploy workflow behind Caddy
- writes the README

**Architecture:** `apps/web` is a Next.js 16 App Router client. It talks to `apps/api` over REST + SSE using the AI SDK `useChat` hook with a custom transport. The transport sends only the new message (DECISIONS 010). Production runs one Compose stack on a VM: Caddy serves `web` at `/` and `api` at `/api`. Data scripts at the repo root download policy PDFs and upload them through the admin API.

**Tech Stack:** Next.js 16.3, React 19, `@ai-sdk/react` 4 + `ai` 7, Tailwind CSS 4 (`@tailwindcss/postcss`), react-pdf 11 (pdfjs-dist 6.3.289, same as core), react-markdown 10 + remark-gfm 4, Vitest 4 + Testing Library (web unit tests), Docker multi-stage builds, Caddy 2, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-10-03-clausecite-design.md` (§4.6 UI, §10 deployment, §11 data sources, §8 security) plus `DECISIONS.md` 001–012. Read both before any task.

## Global Constraints

- Everything from Phase 1A still holds:
  - ESM everywhere, with `.js` relative imports in Node packages
  - TypeScript ^6.0.2 and Vitest ^4.1.2
  - explicit `@Inject(...)` on every Nest constructor param
  - apps never import `drizzle-orm`/`pg` directly
  - `pnpm format:check`, `pnpm lint` and `pnpm typecheck` must stay green
  - commits use Conventional Commits and end with a `Co-Authored-By:` trailer naming the model that wrote them
- Local dev ports:
  - Postgres **5433**, RabbitMQ 5672 / UI 15672, Redis 6379, cache Redis **6380**
  - API 3001, web 3000
- **Web ↔ API contract** (DECISIONS 010):
  - `POST /chat` body is `{ conversationId?, message, documentIds?, mode: 'quick' }`
  - **never send `documentIds: []` for "all policies"; omit the field instead** (an empty list matches nothing)
  - the stream emits `start` → `data-sources` → text → `data-meta` (`ChatMeta`: `answer`, `citations`, `suggestions`, `status`, …) → `finish`
  - the UI renders the cleaned `meta.answer` once it arrives
- Web env: `NEXT_PUBLIC_API_URL` (dev `http://localhost:3001`, prod `/api`). The web never sees server secrets.
- Tokens:
  - the guest JWT lives in `localStorage` key `clausecite.session` as `{ token, role, expiresAt }`
  - admin login replaces it with an admin session
  - any 401 refreshes the guest token once
- Spend protection (DECISIONS 012):
  - global daily token cap `GLOBAL_DAILY_TOKEN_BUDGET` (default 2,000,000), fail-closed
  - nominal charge `SEARCH_TOKEN_COST` (default 300) per `/search` call and per refused chat
  - IPv6 clients are bucketed by /64
  - `TRUST_PROXY_HOPS` env (default **0**; production 1 behind Caddy)
- **Real policy PDFs are never committed.** `data/sources.json` (URLs + metadata) and `data/sources.lock.json` (sha256 + bytes of what was ingested) are committed. Downloads go to `data/pdfs/sources/` (git-ignored).
- No secrets in the repo, images or logs. Production config comes from a server-side `.env.prod` that is not in git.

---

### Task 1: API survives broker loss (DECISIONS 011)

**Files:**
- Create: `apps/api/src/infra/rabbit-publisher.ts`
- Modify: `apps/api/src/infra/tokens.ts` (`RABBIT` becomes the `RabbitPublisher` instance), `apps/api/src/infra/infra.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/documents/documents.service.ts`, `apps/api/test/harness.ts` (`rabbit` handle type)
- Modify: `DECISIONS.md` (011: status → "resolved in Phase 1B")
- Test: `apps/api/src/infra/rabbit-publisher.spec.ts`; extend `apps/api/test/health.e2e.int.spec.ts`

**Interfaces:**
- Consumes: core `connectRabbit(url, { retryDelaysMs, onClose })`, `publishIngestJob(channel, id)`, `RabbitConnection`.
- Produces:
  - `class RabbitPublisher { constructor(connect: () => Promise<RabbitConnection>, logger, opts?: { connectTimeoutMs?: number }); isConnected(): boolean; ensureConnected(): Promise<RabbitConnection>; publishIngestJob(documentId: string): Promise<void>; checkHealthy(timeoutMs: number): Promise<boolean>; close(): Promise<void> }`
  - Behavior:
    - connects lazily
    - never exits the process
    - `onClose` drops the cached connection so the next call reconnects
    - `ensureConnected` serializes concurrent connects (one in-flight promise)
    - a connect that fails or times out (default 5000 ms) rejects with `BrokerUnavailableError`

Rules:
- API boot no longer requires RabbitMQ.
- `/health` reports `rabbitmq: false` (503 degraded) while it's down. The health probe uses `checkHealthy(2000)`, which tries `ensureConnected` and then `checkExchange`.
- `DocumentsService` publishes through `RabbitPublisher.publishIngestJob`. Its existing enqueue-failure handling (delete row / mark failed, then 503) stays unchanged: `BrokerUnavailableError` is just another publish failure.
- The worker stays crash-only (DECISIONS 004 is unchanged).

- [ ] **Step 1: Failing unit tests**

`apps/api/src/infra/rabbit-publisher.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { BrokerUnavailableError, RabbitPublisher } from './rabbit-publisher.js';

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeConnection() {
  const handlers: { onClose?: () => void } = {};
  const conn = {
    connection: {},
    channel: { checkExchange: vi.fn(async () => ({})) },
    close: vi.fn(async () => undefined),
  };
  return { conn, handlers };
}

describe('RabbitPublisher', () => {
  it('connects lazily and reuses the connection', async () => {
    const { conn } = fakeConnection();
    const connect = vi.fn(async () => conn as never);
    const p = new RabbitPublisher(connect, quiet);
    expect(p.isConnected()).toBe(false);
    await p.ensureConnected();
    await p.ensureConnected();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(p.isConnected()).toBe(true);
  });

  it('serializes concurrent connects', async () => {
    const { conn } = fakeConnection();
    let resolve!: (v: unknown) => void;
    const connect = vi.fn(() => new Promise((r) => (resolve = r)) as never);
    const p = new RabbitPublisher(connect, quiet);
    const a = p.ensureConnected();
    const b = p.ensureConnected();
    resolve(conn);
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('rejects with BrokerUnavailableError on connect failure or timeout, then retries next call', async () => {
    const { conn } = fakeConnection();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(conn);
    const p = new RabbitPublisher(connect, quiet, { connectTimeoutMs: 50 });
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(p.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(p.ensureConnected()).resolves.toBe(conn);
  });

  it('drops the connection when the broker closes it and reconnects on next use', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    let onClose: (() => void) | undefined;
    const connect = vi
      .fn()
      .mockImplementationOnce(async (cb: () => void) => ((onClose = cb), first.conn))
      .mockImplementationOnce(async () => second.conn);
    const p = new RabbitPublisher(connect, quiet);
    await p.ensureConnected();
    onClose?.();
    expect(p.isConnected()).toBe(false);
    await expect(p.ensureConnected()).resolves.toBe(second.conn);
  });

  it('checkHealthy returns false instead of throwing', async () => {
    const p = new RabbitPublisher(vi.fn().mockRejectedValue(new Error('down')), quiet);
    await expect(p.checkHealthy(50)).resolves.toBe(false);
  });
});
```
The `connect` function receives the `onClose` callback as its first argument (see Step 3), so tests can trigger it.

Run: `pnpm --filter @clausecite/api test -- rabbit-publisher` → FAIL (module missing).

- [ ] **Step 2: e2e expectation**

Add to `apps/api/test/health.e2e.int.spec.ts` a separate `describe` that starts its own harness, then stops the RabbitMQ container: `await h.rabbitContainer.stop()` (expose `rabbitContainer` from the harness). Assert:
- `GET /health` returns 503 with `checks.rabbitmq === false` and `db`/`redis` true, within 5 s;
- the process is still serving `GET /health` afterwards.

Expose `rabbitContainer` on `Harness` and make `stop()` tolerate an already-stopped container.

- [ ] **Step 3: Implement**

`apps/api/src/infra/rabbit-publisher.ts`:
```ts
import { publishIngestJob, type RabbitConnection } from '@clausecite/core';

export class BrokerUnavailableError extends Error {
  override name = 'BrokerUnavailableError';
}

type Logger = { log(m: string): void; warn(m: string): void; error(m: string): void };
type Connect = (onClose: () => void) => Promise<RabbitConnection>;

export class RabbitPublisher {
  private conn: RabbitConnection | null = null;
  private connecting: Promise<RabbitConnection> | null = null;
  private closed = false;

  constructor(
    private readonly connect: Connect,
    private readonly logger: Logger,
    private readonly opts: { connectTimeoutMs?: number } = {},
  ) {}

  isConnected(): boolean {
    return this.conn !== null;
  }

  ensureConnected(): Promise<RabbitConnection> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.closed) return Promise.reject(new BrokerUnavailableError('publisher closed'));
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<RabbitConnection> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const conn = await Promise.race([
        this.connect(() => {
          this.logger.warn('RabbitMQ connection closed; will reconnect on next publish');
          this.conn = null;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      this.conn = conn;
      this.logger.log('RabbitMQ connected');
      return conn;
    } catch (err) {
      throw new BrokerUnavailableError(`RabbitMQ unavailable: ${(err as Error).message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async publishIngestJob(documentId: string): Promise<void> {
    const conn = await this.ensureConnected();
    await publishIngestJob(conn.channel, documentId);
  }

  async checkHealthy(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          const conn = await this.ensureConnected();
          await conn.channel.checkExchange('ingest');
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const conn = this.conn ?? (await this.connecting?.catch(() => null)) ?? null;
    this.conn = null;
    await conn?.close();
  }
}
```

In `infra.module.ts`, the `RABBIT` provider becomes:
```ts
{
  provide: RABBIT,
  inject: [API_ENV],
  useFactory: (env: ApiConfig) =>
    new RabbitPublisher(
      (onClose) => connectRabbit(env.RABBITMQ_URL, { retryDelaysMs: env.INGEST_RETRY_DELAYS_MS, onClose }),
      new Logger('Rabbit'),
    ),
},
```
- No connect happens at boot.
- `InfraLifecycle` calls `publisher.close()`.
- `HealthController` uses `publisher.checkHealthy(HEALTH_PROBE_TIMEOUT_MS)` for the rabbitmq probe.
- `DocumentsService` replaces `publishIngestJob(this.rabbit.channel, id)` with `this.rabbit.publishIngestJob(id)`.
- Update every test that used `h.rabbit.channel`. The documents e2e reads queue messages; give the harness its own consumer connection for those reads (`harness.inspect = await connectRabbit(url, …)`), so tests never depend on the publisher's private channel.
- Update the `documents.service.spec.ts` fakes to the new `publishIngestJob(id)` method.

- [ ] **Step 4: Verify**

Run: `pnpm build && pnpm --filter @clausecite/api test && pnpm --filter @clausecite/api test:int && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all PASS, including the new broker-down health test.

Update `DECISIONS.md` 011: change the title suffix to "(resolved in Phase 1B)" and add a line: "The API now uses a lazy, reconnecting `RabbitPublisher`; it boots and serves chat/search without the broker, `/health` reports `rabbitmq: false`, uploads return 503 until the broker is back. The worker remains crash-only."

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): lazy reconnecting rabbit publisher; api survives broker loss

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Spend protection (DECISIONS 012): global cap, nominal charges, IPv6 /64, trust-proxy hops

**Files:**
- Create: `apps/api/src/limits/client-ip.ts`
- Modify: `packages/core/src/config/env.ts` (`authEnv`: `GLOBAL_DAILY_TOKEN_BUDGET` default 2,000,000 and `SEARCH_TOKEN_COST` default 300; `apiEnv`: `TRUST_PROXY_HOPS` coerce int ≥ 0, default 0)
- Modify: `.env.example` (document the three variables), `apps/api/src/bootstrap.ts` (`trust proxy` = `env.TRUST_PROXY_HOPS`), `apps/api/test/harness.ts` (sets `TRUST_PROXY_HOPS: '1'`, because the limit e2e tests use `X-Forwarded-For`)
- Modify: `apps/api/src/limits/limits.service.ts`, `apps/api/src/limits/rate-limit.guard.ts` (use `clientIpKey(req.ip)`), `apps/api/src/search/search.controller.ts`, `apps/api/src/chat/chat.service.ts`
- Modify: `DECISIONS.md` (012 → "implemented", list remaining manual step: OpenRouter key credit limit)
- Test: `apps/api/src/limits/client-ip.spec.ts`, extend `limits.service.int.spec.ts`, `search.e2e.int.spec.ts`, `chat.e2e.int.spec.ts`; core `env.spec.ts`

**Interfaces:**
- Produces:
  - `clientIpKey(ip: string | undefined): string`:
    - IPv4 → as-is
    - IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`
    - other IPv6 → the first 4 hextets of the fully expanded address + `::/64` (e.g. `2001:db8:abcd:12::/64`)
    - undefined/invalid → `'unknown'`
  - `LimitsService.assertBudget(user)` also checks the global key `budget:global:<utc-day>` against `GLOBAL_DAILY_TOKEN_BUDGET`, for admins too. When exhausted it throws 429 `{ message: 'Service daily budget exhausted', retryAfterSeconds }`.
  - `LimitsService.recordUsage(user, tokens)` increments the global key for every role (admins included) and the per-user key for guests only.
  - `LimitsService.chargeSearch(user)`: `recordUsage(user, SEARCH_TOKEN_COST)`.

Rules:
- `POST /search` calls `assertBudget(user)` before retrieval and `chargeSearch(user)` after it, even on refusal.
- Chat: a refusal records the rewrite tokens plus `SEARCH_TOKEN_COST`. A completed answer records rewrite + model tokens plus `SEARCH_TOKEN_COST` (retrieval embed + rerank).
- The guard and `LimitsService.check` use `clientIpKey(req.ip)` for every IP bucket.
- `TRUST_PROXY_HOPS=0` means `req.ip` is the socket address and `X-Forwarded-For` is ignored.

- [ ] **Step 1: Failing tests**

`apps/api/src/limits/client-ip.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { clientIpKey } from './client-ip.js';

describe('clientIpKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::99', '2001:db8:abcd:12::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    [undefined, 'unknown'],
    ['not-an-ip', 'unknown'],
  ])('%s → %s', (ip, key) => {
    expect(clientIpKey(ip)).toBe(key);
  });

  it('puts two addresses from the same /64 in one bucket and different /64s apart', () => {
    expect(clientIpKey('2001:db8:1:2::a')).toBe(clientIpKey('2001:db8:1:2:ffff::b'));
    expect(clientIpKey('2001:db8:1:2::a')).not.toBe(clientIpKey('2001:db8:1:3::a'));
  });
});
```
Add `limits.service.int.spec.ts` cases:
- With `GLOBAL_DAILY_TOKEN_BUDGET: 1000`, recording 600 tokens for guest A and 400 for **admin** B makes `assertBudget` throw 429 for a fresh guest C *and* for an admin (message `Service daily budget exhausted`).
- `chargeSearch` increments both the global and the guest keys by `SEARCH_TOKEN_COST`.
- Admin usage increments the global key but not a per-user key.

Add e2e cases:
- In search e2e: each `/search` increases `budget:global:<day>` by 300.
- In chat e2e: a refused chat increases the global key by exactly `SEARCH_TOKEN_COST` (no rewrite on a first turn), and a completed chat increases it by the model tokens + 300.

Add core env.spec cases for the three new variables' defaults and coercion.

Run the focused tests → FAIL.

- [ ] **Step 2: Implement `clientIpKey`**

`apps/api/src/limits/client-ip.ts`:
```ts
import { isIPv4, isIPv6 } from 'node:net';

function expandIPv6(ip: string): string[] {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((part) => part.replace(/^0+(?=.)/, '').toLowerCase());
}

/** Rate-limit bucket key: IPv4 as-is, IPv6 by /64 (one subscriber typically owns a whole /64). */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return 'unknown';
  return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
}
```
(Strip a zone suffix such as `%eth0` before `isIPv6` if present.)

- [ ] **Step 3: Implement the global cap and charges**

In `LimitsService`:
```ts
private globalKey = () => `budget:global:${utcDay()}`;

async assertBudget(user: AuthUser): Promise<void> {
  const globalUsed = Number((await this.redis.get(this.globalKey())) ?? 0);
  if (globalUsed >= this.env.GLOBAL_DAILY_TOKEN_BUDGET) {
    throw new HttpException(
      { message: 'Service daily budget exhausted', retryAfterSeconds: secondsUntilUtcMidnight() },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (user.role === 'admin') return;
  // …existing per-guest check unchanged…
}

async recordUsage(user: AuthUser, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || Math.round(tokens) <= 0) return;
  const amount = Math.round(tokens);
  const multi = this.redis.multi().incrby(this.globalKey(), amount).expire(this.globalKey(), 2 * 24 * 3600);
  if (user.role !== 'admin') {
    const key = `budget:${user.id}:${utcDay()}`;
    multi.incrby(key, amount).expire(key, 2 * 24 * 3600);
  }
  execResults(await multi.exec()); // existing helper: throws on null EXEC / command errors
}

chargeSearch(user: AuthUser): Promise<void> {
  return this.recordUsage(user, this.env.SEARCH_TOKEN_COST);
}
```
Keep the existing fail-closed behavior: if Redis errors in `get`, the request fails rather than being allowed.

- `SearchController.search`: inject `LimitsService`; `await this.limits.assertBudget(user)` before `resolveMany`/`run`; `await this.limits.chargeSearch(user)` after `run` (inside `try/finally` so a retrieval error still charges). Add `@CurrentUser() user: AuthUser`.
- `ChatService.stream`: refusal path → `recordUsage(user, tokens + this.env.SEARCH_TOKEN_COST)`; complete path → `recordUsage(user, tokens + this.env.SEARCH_TOKEN_COST)`; error path unchanged (rewrite tokens + model tokens if known). Inject `API_ENV` if not already present.
- `bootstrap.ts`: `app.set('trust proxy', env.TRUST_PROXY_HOPS)`.

- [ ] **Step 4: Verify**

Run: `pnpm build && pnpm --filter @clausecite/core test && pnpm --filter @clausecite/api test && pnpm --filter @clausecite/api test:int && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all PASS.

Update `DECISIONS.md` 012: mark the code items implemented. Keep the manual step: "Set a credit limit on the OpenRouter key (openrouter.ai → Keys → Edit → Credit limit) before going public."

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): global daily spend cap, nominal search/refusal charges, ipv6 /64 buckets, env trust-proxy

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Backend follow-ups: query-embed timeout, re-embed script, worker composition test

**Files:**
- Modify: `packages/core/src/llm/embed.ts` (`embedQuery(model, value, opts?: { timeoutMs?: number })`), `packages/core/src/llm/cached-embedder.ts` (pass `timeoutMs`), `apps/api/src/search/retrieval.service.ts` (`timeoutMs: 5000`)
- Create: `scripts/reembed.ts`; root `package.json` script `"reembed": "node --env-file-if-exists=.env scripts/reembed.ts"`
- Create: `apps/worker/src/ingest.worker.int.spec.ts`
- Test: extend `packages/core/src/llm/embed.spec.ts`

**Interfaces:**
- `embedQuery(model, value, { timeoutMs })` aborts the embedding call after `timeoutMs` via `abortSignal: AbortSignal.timeout(timeoutMs)`. With no timeout it behaves as before.
- `scripts/reembed.ts`:
  - finds `documents` with `status = 'ready'` and `embedding_model IS DISTINCT FROM <EMBEDDING_MODEL>`
  - resets them to `queued`/`attempts 0`
  - publishes an ingest job for each
  - prints `re-enqueued N documents (model → <EMBEDDING_MODEL>)`
  - exits 0
  - supports `--dry-run`, which only prints the list

- [ ] **Step 1: Failing test: query-embed timeout**

In `embed.spec.ts`, use a mock embedding model whose `doEmbed` resolves after 200 ms and honours `abortSignal`. Assert that `embedQuery(model, 'x', { timeoutMs: 20 })` rejects in under 150 ms, and that `embedQuery(model, 'x')` resolves. In `mock-models.ts`, give `mockEmbeddingModel` an optional `delayMs` that rejects with the abort reason when `options.abortSignal` fires.

- [ ] **Step 2: Implement the timeout**

`embed.ts`:
```ts
export async function embedQuery(
  model: EmbeddingModel,
  value: string,
  opts: { timeoutMs?: number } = {},
): Promise<number[]> {
  const res = await embed({
    model,
    value,
    maxRetries: 2,
    ...(opts.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  return res.embedding;
}
```
Thread `timeoutMs` through `createCachedQueryEmbedder(..., { timeoutMs })` and set it to 5000 in `RetrievalService` (spec §7: embed 5 s).

- [ ] **Step 3: Re-embed script**

`scripts/reembed.ts`:
```ts
// Usage: pnpm reembed [--dry-run]
// Re-enqueues every ready document embedded with a different model than EMBEDDING_MODEL (spec §3.5).
import {
  and, connectRabbit, createDb, dbEnv, documents, eq, llmEnv, loadEnv, publishIngestJob, rabbitEnv, sql,
} from '@clausecite/core';

const dryRun = process.argv.includes('--dry-run');
const { DATABASE_URL } = loadEnv(dbEnv);
const { EMBEDDING_MODEL } = loadEnv(llmEnv);
const { db, pool } = createDb(DATABASE_URL, 2);

const stale = await db
  .select({ id: documents.id, slug: documents.slug, embeddingModel: documents.embeddingModel })
  .from(documents)
  .where(and(eq(documents.status, 'ready'), sql`${documents.embeddingModel} IS DISTINCT FROM ${EMBEDDING_MODEL}`));

for (const d of stale) console.log(`${d.slug}: ${d.embeddingModel ?? '(none)'} → ${EMBEDDING_MODEL}`);

if (!dryRun && stale.length > 0) {
  const rabbit = loadEnv(rabbitEnv);
  const conn = await connectRabbit(rabbit.RABBITMQ_URL, { retryDelaysMs: rabbit.INGEST_RETRY_DELAYS_MS });
  try {
    for (const d of stale) {
      await db.update(documents).set({ status: 'queued', attempts: 0, error: null }).where(eq(documents.id, d.id));
      await publishIngestJob(conn.channel, d.id);
    }
  } finally {
    await conn.close();
  }
}
console.log(`${dryRun ? 'would re-enqueue' : 're-enqueued'} ${stale.length} documents (model → ${EMBEDDING_MODEL})`);
await pool.end();
```
(Re-export `sql` from core if not already exported. `llmEnv` requires `OPENROUTER_API_KEY`; that's fine because `.env` has it.)

Manual check against compose infra: `pnpm build && pnpm reembed --dry-run`. Expected: it lists 0 or more documents and prints the summary.

- [ ] **Step 4: Worker composition test**

`apps/worker/src/ingest.worker.int.spec.ts`: builds the real `IngestWorker` (from `ingest.worker.ts`) by hand, with no Nest. It verifies that the worker's own `readFile` closure resolves `documents.file_path` names against `STORAGE_DIR`, end to end.
```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connectRabbit, documents, eq, publishIngestJob, type RabbitConnection } from '@clausecite/core';
import { mockEmbeddingModel, startTestDb, type TestDb } from '@clausecite/core/testing';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngestWorker } from './ingest.worker.js';
// …start pg + rabbit, mkdtemp STORAGE_DIR, copy the fixture to `${sha}.pdf`, insert a documents row with
// filePath = `${sha}.pdf`, construct IngestWorker(env, database, rabbit) where env has STORAGE_DIR = temp dir
// and the models factory is overridable (see below), call onApplicationBootstrap(), publish the job, wait for
// status 'ready', then onApplicationShutdown().
```
`IngestWorker` builds its models with `createModels(env)` and would call OpenRouter. Add an optional 4th constructor parameter, `@Optional() @Inject(WORKER_MODELS) models?: Models`, and use it when given (`this.models ?? createModels(this.env)`). The test passes `{ embedding: mockEmbeddingModel(), ids: { embedding: 'mock-embedding' } }`. Assert:
- the document reaches `ready` with `chunkCount > 0`
- a second document whose file is missing from STORAGE_DIR ends `failed` with error starting `FILE_NOT_FOUND`
- `onApplicationShutdown` resolves cleanly

- [ ] **Step 5: Verify and commit**

Run: `pnpm build && pnpm --filter @clausecite/core test && pnpm --filter @clausecite/worker test:int && pnpm --filter @clausecite/api test:int && pnpm typecheck && pnpm lint && pnpm format:check`
```bash
git add -A
git commit -m "feat: 5 s query-embed timeout, reembed script, worker storage composition test

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 4: Web scaffold, session and API client, documents page, admin login and upload

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/postcss.config.mjs`, `apps/web/vitest.config.ts`, `apps/web/vitest.setup.ts`, `apps/web/next-env.d.ts` (generated by Next; commit it)
- Create: `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/app/documents/page.tsx`, `apps/web/src/app/admin/page.tsx`
- Create: `apps/web/src/lib/config.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`
- Create: `apps/web/src/components/nav-bar.tsx`, `apps/web/src/components/status-badge.tsx`, `apps/web/src/components/documents-table.tsx`, `apps/web/src/components/upload-form.tsx`
- Modify: root `.oxlintrc.json` (ignore `**/.next/**` already; add `**/next-env.d.ts`), `.prettierignore` (add `**/.next/`, `**/next-env.d.ts`), `turbo.json` (no change needed: build outputs already include `.next/**`)
- Test: `apps/web/src/lib/session.spec.ts`, `apps/web/src/lib/api.spec.ts`, `apps/web/src/components/documents-table.spec.tsx`

**Interfaces:**
- `API_URL` (from `NEXT_PUBLIC_API_URL`, default `http://localhost:3001`, no trailing slash).
- `type Session = { token: string; role: 'guest' | 'admin'; expiresAt: string }`.
- Session functions:
  - `loadSession(): Session | null`, which ignores sessions expiring within 60 s
  - `ensureSession(): Promise<Session>`, which returns a valid stored session or obtains a guest one via `POST /auth/guest`; concurrent callers share one in-flight request
  - `adminLogin(email, password): Promise<Session>`
  - `logout(): void` (clears storage)
  - `onSessionChange(cb): () => void`, a `storage`-event + in-tab subscriber
- `class ApiError extends Error { status: number; retryAfterSeconds?: number; body: unknown }`.
- `apiFetch<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>`:
  - adds the bearer token
  - on 401, clears the session, obtains a fresh guest token and retries once
  - parses JSON
  - throws `ApiError` on non-2xx, taking `retryAfterSeconds` from the body or the `Retry-After` header
- `parseApiErrorMessage(message: string): { status?: number; retryAfterSeconds?: number; text: string }`, used for errors that `useChat` surfaces as raw response text in Task 5.
- `type PublicDocument = { id; slug; title; insurer; product; policyType; status: 'queued'|'processing'|'ready'|'failed'; error: string | null; pageCount: number | null; chunkCount: number | null; embeddingModel: string | null; attempts: number; createdAt: string; updatedAt: string }`. Guests receive only an error *code* in `error` (Phase 1A Task 13).
- Pages:
  - `/documents` lists documents (polling every 5 s while any is `queued`/`processing`) and shows the upload form plus Re-ingest buttons only for admin sessions.
  - `/admin` is the login form. On success it redirects to `/documents`.
  - Nav: ClauseCite logo/title, Chat (`/`), Policies (`/documents`), and "Admin login"/"Log out" depending on role.

- [ ] **Step 1: Scaffold**

`apps/web/package.json`:
```json
{
  "name": "@clausecite/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start --port 3000",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:int": "echo 'no web integration tests' && exit 0"
  },
  "dependencies": {
    "@ai-sdk/react": "^4.0.0",
    "ai": "^7.0.0",
    "next": "^16.3.0",
    "pdfjs-dist": "6.3.289",
    "react": "^19.2.1",
    "react-dom": "^19.2.1",
    "react-markdown": "^10.1.0",
    "react-pdf": "^11.0.0",
    "remark-gfm": "^4.0.1"
  },
  "devDependencies": {
    "@clausecite/core": "workspace:*",
    "@tailwindcss/postcss": "^4.3.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.3.0"
  }
}
```
`@clausecite/core` is a **devDependency used only via `import type`**. The web bundle must never import a value from core: core pulls in pg, pdfjs and amqplib. Check this with `grep -rn "from '@clausecite/core'" apps/web/src`. Every match must be `import type`. Pin `pdfjs-dist` to the exact version react-pdf 11 uses (6.3.289), so the worker file matches.

`apps/web/next.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
};
export default config;
```

`apps/web/postcss.config.mjs`:
```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2023"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```
(The web package uses `moduleResolution: bundler`, so relative imports do **not** take `.js` extensions; use the `@/` alias. This exception to the Node ESM rule is local to `apps/web`.)

`apps/web/vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], include: ['src/**/*.spec.{ts,tsx}'], globals: true },
});
```
`apps/web/vitest.setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
```

`apps/web/src/app/globals.css`:
```css
@import 'tailwindcss';

:root {
  color-scheme: light dark;
}
body {
  @apply bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100;
}
```

Run: `pnpm install`. If `jsdom@^26` or `@vitejs/plugin-react@^5` don't satisfy peers, use the latest versions compatible with vitest 4 and record the deviation.

- [ ] **Step 2: Failing tests for session and API client**

`apps/web/src/lib/session.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { adminLogin, ensureSession, loadSession, logout } from './session';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('session', () => {
  it('obtains and stores a guest session once for concurrent callers', async () => {
    const fetchMock = vi.fn(async () => ok({ token: 't1', user: { id: 'u', role: 'guest' }, expiresAt: future() }));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([ensureSession(), ensureSession()]);
    expect(a.token).toBe('t1');
    expect(b.token).toBe('t1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/auth/guest');
    expect(loadSession()?.role).toBe('guest');
  });

  it('ignores sessions that expire within a minute', () => {
    localStorage.setItem('clausecite.session', JSON.stringify({ token: 'x', role: 'guest', expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    expect(loadSession()).toBeNull();
  });

  it('admin login stores an admin session; logout clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ token: 'adm', user: { id: 'a', role: 'admin' }, expiresAt: future() })));
    const s = await adminLogin('a@b.co', 'pw-pw-pw-pw-pw');
    expect(s).toMatchObject({ token: 'adm', role: 'admin' });
    logout();
    expect(loadSession()).toBeNull();
  });
});
```
`apps/web/src/lib/api.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, parseApiErrorMessage } from './api';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('apiFetch', () => {
  it('sends the bearer token and parses JSON', async () => {
    localStorage.setItem('clausecite.session', JSON.stringify({ token: 'tok', role: 'guest', expiresAt: future() }));
    const fetchMock = vi.fn(async () => json(200, [{ id: 'd1' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/documents')).resolves.toEqual([{ id: 'd1' }]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('refreshes the guest token once on 401', async () => {
    localStorage.setItem('clausecite.session', JSON.stringify({ token: 'stale', role: 'guest', expiresAt: future() }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(json(201, { token: 'fresh', user: { role: 'guest' }, expiresAt: future() }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/auth/me')).resolves.toEqual({ ok: true });
    expect(new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get('authorization')).toBe('Bearer fresh');
  });

  it('throws ApiError with retryAfterSeconds on 429', async () => {
    localStorage.setItem('clausecite.session', JSON.stringify({ token: 'tok', role: 'guest', expiresAt: future() }));
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { message: 'Rate limit exceeded', retryAfterSeconds: 42 }, { 'retry-after': '42' })));
    const err = await apiFetch('/search', { method: 'POST', json: { query: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 42, message: 'Rate limit exceeded' });
  });
});

describe('parseApiErrorMessage', () => {
  it('extracts message and retryAfterSeconds from a JSON error body', () => {
    expect(parseApiErrorMessage('{"statusCode":429,"message":"Daily token budget exhausted","retryAfterSeconds":120}')).toEqual({
      status: 429, retryAfterSeconds: 120, text: 'Daily token budget exhausted',
    });
    expect(parseApiErrorMessage('boom')).toEqual({ text: 'boom' });
  });
});
```
Run: `pnpm --filter @clausecite/web test` → FAIL (modules missing).

- [ ] **Step 3: Implement config, session, API client and types**

`apps/web/src/lib/config.ts`:
```ts
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
```

`apps/web/src/lib/session.ts`:
```ts
import { API_URL } from './config';

export type Session = { token: string; role: 'guest' | 'admin'; expiresAt: string };
const KEY = 'clausecite.session';
const listeners = new Set<() => void>();
let inflight: Promise<Session> | null = null;

const notify = () => listeners.forEach((l) => l());

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
  } catch {
    return null;
  }
}

function store(s: Session): Session {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: session lives for this page only */
  }
  notify();
  return s;
}

type IssuedToken = { token: string; user: { role: 'guest' | 'admin' }; expiresAt: string };

async function issue(path: string, body?: unknown): Promise<Session> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Partial<IssuedToken> & { message?: string };
  if (!res.ok || !data.token || !data.user || !data.expiresAt) {
    throw new Error(data.message ?? `auth failed (${res.status})`);
  }
  return store({ token: data.token, role: data.user.role, expiresAt: data.expiresAt });
}

export function ensureSession(): Promise<Session> {
  const existing = loadSession();
  if (existing) return Promise.resolve(existing);
  inflight ??= issue('/auth/guest').finally(() => {
    inflight = null;
  });
  return inflight;
}

export const adminLogin = (email: string, password: string) => issue('/auth/login', { email, password });

export function logout(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  notify();
}

export function clearSession(): void {
  logout();
}

export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}
```

`apps/web/src/lib/api.ts`:
```ts
import { API_URL } from './config';
import { clearSession, ensureSession } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join(', ');
  }
  return fallback;
}

async function doFetch(path: string, init: RequestInit & { json?: unknown }, token: string) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return fetch(`${API_URL}${path}`, { ...init, headers, body });
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  let res = await doFetch(path, init, (await ensureSession()).token);
  if (res.status === 401) {
    clearSession();
    res = await doFetch(path, init, (await ensureSession()).token);
  }
  const text = await res.text();
  const body: unknown = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const fromBody =
      body && typeof body === 'object' && typeof (body as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
        ? (body as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined;
    const header = Number(res.headers.get('retry-after'));
    throw new ApiError(messageOf(body, `request failed (${res.status})`), res.status, body, fromBody ?? (Number.isFinite(header) && header > 0 ? header : undefined));
  }
  return body as T;
}

export function parseApiErrorMessage(message: string): { status?: number; retryAfterSeconds?: number; text: string } {
  try {
    const body = JSON.parse(message) as { statusCode?: number; message?: unknown; retryAfterSeconds?: number };
    return {
      ...(typeof body.statusCode === 'number' ? { status: body.statusCode } : {}),
      ...(typeof body.retryAfterSeconds === 'number' ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
      text: messageOf(body, message),
    };
  } catch {
    return { text: message };
  }
}
```
Note on `parseApiErrorMessage`: Nest's 429 body is `{ message, retryAfterSeconds }` (an HttpException with an object response). The `statusCode` may be absent, so the test's expected `status: 429` comes from the body when present. Make the test body include `"statusCode":429` (as written) and treat a missing one as unknown.

`apps/web/src/lib/types.ts`:
```ts
export type { ChatMeta, ClauseCiteUIMessage, SourceRef } from '@clausecite/core';

export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type PublicDocument = {
  id: string;
  slug: string;
  title: string;
  insurer: string;
  product: string;
  policyType: string;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number | null;
  embeddingModel: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};
```
(`export type { … } from` keeps core out of the bundle.)

- [ ] **Step 4: Layout, nav, documents page, admin page (with a component test)**

`apps/web/src/components/documents-table.spec.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PublicDocument } from '@/lib/types';
import { DocumentsTable } from './documents-table';

const doc = (over: Partial<PublicDocument>): PublicDocument => ({
  id: 'd1', slug: 'star', title: 'Star Comprehensive', insurer: 'Star Health', product: 'Comprehensive', policyType: 'health',
  status: 'ready', error: null, pageCount: 42, chunkCount: 180, embeddingModel: 'm', attempts: 0,
  createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', ...over,
});

describe('DocumentsTable', () => {
  it('renders status, pages and chunks; hides admin actions for guests', () => {
    render(<DocumentsTable documents={[doc({}), doc({ id: 'd2', title: 'Broken', status: 'failed', error: 'NO_TEXT_LAYER' })]} isAdmin={false} onReingest={vi.fn()} />);
    expect(screen.getByText('Star Comprehensive')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('NO_TEXT_LAYER')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-ingest/i })).toBeNull();
  });

  it('shows re-ingest for admins and calls back with the id', async () => {
    const onReingest = vi.fn();
    render(<DocumentsTable documents={[doc({})]} isAdmin onReingest={onReingest} />);
    await userEvent.click(screen.getByRole('button', { name: /re-ingest/i }));
    expect(onReingest).toHaveBeenCalledWith('d1');
  });
});
```

`apps/web/src/components/status-badge.tsx`:
```tsx
import type { DocumentStatus } from '@/lib/types';

const styles: Record<DocumentStatus, string> = {
  ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  queued: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  processing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>{status}</span>;
}
```

`apps/web/src/components/documents-table.tsx`:
```tsx
'use client';
import type { PublicDocument } from '@/lib/types';
import { StatusBadge } from './status-badge';

export function DocumentsTable({
  documents,
  isAdmin,
  onReingest,
}: {
  documents: PublicDocument[];
  isAdmin: boolean;
  onReingest: (id: string) => void;
}) {
  if (documents.length === 0) return <p className="text-sm text-zinc-500">No policies ingested yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 pr-4">Policy</th>
            <th className="py-2 pr-4">Insurer</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Pages</th>
            <th className="py-2 pr-4">Chunks</th>
            {isAdmin && <th className="py-2" />}
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => (
            <tr key={d.id} className="border-b border-zinc-100 align-top dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{d.title}</td>
              <td className="py-2 pr-4">{d.insurer}</td>
              <td className="py-2 pr-4">
                <StatusBadge status={d.status} />
                {d.error && <div className="mt-1 font-mono text-xs text-red-600">{d.error}</div>}
              </td>
              <td className="py-2 pr-4">{d.pageCount ?? '—'}</td>
              <td className="py-2 pr-4">{d.chunkCount ?? '—'}</td>
              {isAdmin && (
                <td className="py-2">
                  <button type="button" onClick={() => onReingest(d.id)} className="rounded border px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
                    Re-ingest
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/components/upload-form.tsx`: a client form with fields:
- `file` (accept `application/pdf`, required)
- `slug` (pattern `[a-z0-9-]{3,80}`)
- `title`, `insurer`, `product`, each required
- `policy_type` (default `health`)

On submit it builds `FormData` and calls `apiFetch('/documents', { method: 'POST', body: formData })`. Do **not** set content-type; the browser sets the multipart boundary. It shows "Uploaded — ingesting…" on 201, "Already ingested (deduplicated)" on 200, or the `ApiError.message` in red. It then calls `onUploaded()` and resets.

`apps/web/src/components/nav-bar.tsx`: a client component that subscribes via `onSessionChange` and shows links Chat `/`, Policies `/documents`. It shows `Admin login` (`/admin`) for guest/none, or `Log out` (calls `logout()` then `router.push('/')`) for admin.

`apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavBar } from '@/components/nav-bar';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClauseCite — insurance policy answers with citations',
  description: 'Ask questions about health insurance policy wordings and get answers cited to the exact clause and page.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <NavBar />
        <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
```

`apps/web/src/app/documents/page.tsx`: a client page with these steps:
1. `useEffect` → `ensureSession()`.
2. Load `apiFetch<PublicDocument[]>('/documents')`.
3. Poll every 5 s while any doc is queued or processing; clear the interval on unmount.
4. `isAdmin = loadSession()?.role === 'admin'`, updated via `onSessionChange`.
5. Render `<DocumentsTable … onReingest={(id) => apiFetch(`/documents/${id}/reingest`, { method: 'POST' }).then(reload)} />`, plus `<UploadForm onUploaded={reload} />` when admin.
6. Show errors in a red banner.

`apps/web/src/app/admin/page.tsx`: a client login form (email, password) → `adminLogin(email, password)`. On success it runs `router.push('/documents')`; on error it shows the message, including "Rate limit exceeded" with seconds when present.

`apps/web/src/app/page.tsx` (temporary until Task 5): renders `<p>Chat coming next.</p>`. Task 5 replaces it.

- [ ] **Step 5: Verify**

Run:
```bash
pnpm install
pnpm --filter @clausecite/web test
pnpm --filter @clausecite/web typecheck
pnpm --filter @clausecite/web build
pnpm lint && pnpm format:check
grep -rn "from '@clausecite/core'" apps/web/src | grep -v "import type\|export type" || echo "core is type-only in web"
```
Expected: all tests PASS, build succeeds, and the grep prints `core is type-only in web`.

Manual: with compose infra + API running (`pnpm --filter @clausecite/api start`), run `pnpm --filter @clausecite/web dev`. Open http://localhost:3000/documents: the list loads and the guest token is stored. `/admin` logs in when a valid ADMIN_PASSWORD is set.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): next 16 scaffold, guest/admin session, api client, policies page with admin upload

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 5: Chat page: useChat transport, cited markdown answers, scope selector, limits and refusals

**Files:**
- Create: `apps/web/src/lib/citations.ts`, `apps/web/src/lib/chat-transport.ts`
- Create: `apps/web/src/components/chat-view.tsx`, `apps/web/src/components/assistant-message.tsx`, `apps/web/src/components/citation-chip.tsx`, `apps/web/src/components/policy-scope.tsx`
- Modify: `apps/web/src/app/page.tsx` (render `<ChatView />`)
- Test: `apps/web/src/lib/citations.spec.ts`, `apps/web/src/lib/chat-transport.spec.ts`, `apps/web/src/components/assistant-message.spec.tsx`

**Interfaces:**
- `linkifyCitations(text: string, validNs: ReadonlySet<number>): string`: rewrites `[n]` markers whose `n ∈ validNs` into markdown links `[n](#cite-n)`. Markers with invalid `n` are left untouched, as is code inside backticks.
- `createChatTransport(getState: () => { conversationId?: string; documentIds?: string[] }): DefaultChatTransport<ClauseCiteUIMessage>`:
  - `api = ${API_URL}/chat`
  - `headers` resolves the bearer token via `ensureSession()`
  - `prepareSendMessagesRequest` returns `{ body: { conversationId?, message: <text of last user message>, documentIds?: <only when non-empty>, mode: 'quick' } }`
- `<AssistantMessage message={ClauseCiteUIMessage} onCite={(source: SourceRef) => void} />`:
  - text = `meta.answer` when the `data-meta` part exists, else the concatenated text parts
  - valid citation numbers = `meta.citations.map(c => c.n)` when meta exists, else `1..sources.length` while streaming
  - renders markdown via react-markdown + remark-gfm; `#cite-n` links become `<CitationChip n>` buttons that call `onCite(sources[n-1])`
  - `status === 'refused'` → an amber "Not found in the selected policies" callout listing `meta.suggestions` as clickable clause buttons
  - `meta.uncited` → a small "uncited" badge
  - `status === 'error'` is handled by ChatView via `useChat` `error`
- `<PolicyScope documents value={string[] | undefined} onChange />`: "All policies" (undefined) or a checkbox subset of **ready** documents. Choosing all individually collapses back to `undefined`.
- `ChatView` keeps:
  - `conversationId` (captured from the first `data-sources` part via `onData`)
  - scope
  - a "New chat" button (clears messages and conversationId)
  - an input box (disabled while `status` is `submitted`/`streaming`)
  - a Stop button while streaming
  - an error banner: for `useChat` errors, `parseApiErrorMessage(error.message)`, giving "You've hit the limit — try again in {n}s" for 429s, else the generic text
  - selected-source state handed to the panel in Task 6; for now render the selected source's text in a simple `<aside>`

- [ ] **Step 1: Failing tests**

`apps/web/src/lib/citations.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { linkifyCitations } from './citations';

describe('linkifyCitations', () => {
  const valid = new Set([1, 2]);
  it('links valid markers only', () => {
    expect(linkifyCitations('Covered after 24 months [1][2]. Not [7].', valid)).toBe(
      'Covered after 24 months [1](#cite-1)[2](#cite-2). Not [7].',
    );
  });
  it('leaves inline and fenced code untouched', () => {
    expect(linkifyCitations('see `arr[1]` and\n```\nx[2]\n```\nok [2]', valid)).toBe('see `arr[1]` and\n```\nx[2]\n```\nok [2](#cite-2)');
  });
  it('does not double-link existing markdown links', () => {
    expect(linkifyCitations('[1](#cite-1)', valid)).toBe('[1](#cite-1)');
  });
});
```
`apps/web/src/lib/chat-transport.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createChatTransport } from './chat-transport';

describe('createChatTransport', () => {
  it('sends only the new message, conversation id, and non-empty scope', async () => {
    const t = createChatTransport(() => ({ conversationId: 'c1', documentIds: ['star'] })) as unknown as {
      prepareSendMessagesRequest: (o: unknown) => Promise<{ body: unknown }> | { body: unknown };
    };
    const req = await t.prepareSendMessagesRequest({
      id: 'x', api: '/chat', body: undefined, credentials: undefined, headers: undefined, requestMetadata: undefined,
      trigger: 'submit-message', messageId: undefined,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
        { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Is cataract covered?' }] },
      ],
    });
    expect(req.body).toEqual({ conversationId: 'c1', message: 'Is cataract covered?', documentIds: ['star'], mode: 'quick' });
  });

  it('omits documentIds when the scope is all policies or empty', async () => {
    for (const documentIds of [undefined, []]) {
      const t = createChatTransport(() => ({ documentIds })) as unknown as { prepareSendMessagesRequest: (o: unknown) => { body: Record<string, unknown> } };
      const req = await t.prepareSendMessagesRequest({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'q' }] }] });
      expect(req.body).not.toHaveProperty('documentIds');
      expect(req.body).not.toHaveProperty('conversationId');
    }
  });
});
```
If `DefaultChatTransport` keeps `prepareSendMessagesRequest` private, have `createChatTransport` also export the pure `buildChatRequestBody(messages, state)` used inside it, and test that function instead (same assertions).

`apps/web/src/components/assistant-message.spec.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClauseCiteUIMessage, SourceRef } from '@/lib/types';
import { AssistantMessage } from './assistant-message';

const source = (n: number, clauseId: string): SourceRef => ({
  n, chunkId: `c${n}`, documentId: 'd', slug: 'star', documentTitle: 'Star Comprehensive', insurer: 'Star',
  clauseId, clauseIds: [clauseId], sectionPath: ['Section C: Exclusions'], pageStart: 3, pageEnd: 3, content: `text ${clauseId}`, rerankScore: 0.9,
});

const msg = (parts: ClauseCiteUIMessage['parts']): ClauseCiteUIMessage => ({ id: 'a1', role: 'assistant', parts });

describe('AssistantMessage', () => {
  it('renders the cleaned meta answer with clickable chips for valid citations only', async () => {
    const onCite = vi.fn();
    render(
      <AssistantMessage
        onCite={onCite}
        message={msg([
          { type: 'data-sources', data: { conversationId: 'c', question: 'q', sources: [source(1, 'C.3')] } },
          { type: 'text', text: 'Raw streamed [1] and bogus [9].' },
          {
            type: 'data-meta',
            data: {
              messageId: 'a1', conversationId: 'c', status: 'complete', answer: 'Cataract waits **24 months** [1].',
              citations: [{ n: 1, chunkId: 'c1', documentId: 'd', clauseId: 'C.3', pageStart: 3, pageEnd: 3 }],
              uncited: false, usage: null, latencyMs: {}, rerankDegraded: false, suggestions: [],
            },
          },
        ])}
      />,
    );
    expect(screen.queryByText(/bogus/)).toBeNull();
    expect(screen.getByText('24 months')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /source 1/i }));
    expect(onCite).toHaveBeenCalledWith(expect.objectContaining({ clauseId: 'C.3' }));
  });

  it('shows a refusal callout with clickable suggestions', async () => {
    const onCite = vi.fn();
    render(
      <AssistantMessage
        onCite={onCite}
        message={msg([
          { type: 'data-sources', data: { conversationId: 'c', question: 'q', sources: [] } },
          {
            type: 'data-meta',
            data: {
              messageId: 'a1', conversationId: 'c', status: 'refused', answer: 'I could not find an answer…',
              citations: [], uncited: false, usage: null, latencyMs: {}, rerankDegraded: false, suggestions: [source(1, 'B.2')],
            },
          },
        ])}
      />,
    );
    expect(screen.getByText(/not found in the selected policies/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /B\.2/ }));
    expect(onCite).toHaveBeenCalledWith(expect.objectContaining({ clauseId: 'B.2' }));
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement citations and transport**

`apps/web/src/lib/citations.ts`:
```ts
/** Turn valid [n] markers into #cite-n links so react-markdown can render them as chips. */
export function linkifyCitations(text: string, validNs: ReadonlySet<number>): string {
  // Split out fenced blocks and inline code; only transform prose segments.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[(\d+)\](?!\()/g, (m, n: string) => (validNs.has(Number(n)) ? `[${n}](#cite-${n})` : m)),
    )
    .join('');
}
```

`apps/web/src/lib/chat-transport.ts`:
```ts
import { DefaultChatTransport } from 'ai';
import { API_URL } from './config';
import { ensureSession } from './session';
import type { ClauseCiteUIMessage } from './types';

export type ChatRequestState = { conversationId?: string; documentIds?: string[] };

export function buildChatRequestBody(messages: ClauseCiteUIMessage[], state: ChatRequestState) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const message = (last?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  return {
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    message,
    ...(state.documentIds && state.documentIds.length > 0 ? { documentIds: state.documentIds } : {}),
    mode: 'quick' as const,
  };
}

export function createChatTransport(getState: () => ChatRequestState) {
  return new DefaultChatTransport<ClauseCiteUIMessage>({
    api: `${API_URL}/chat`,
    headers: async () => ({ Authorization: `Bearer ${(await ensureSession()).token}` }),
    prepareSendMessagesRequest: ({ messages, headers }) => ({
      body: buildChatRequestBody(messages, getState()),
      headers,
    }),
  });
}
```
(`DefaultChatTransport` is a value import from `ai`, which is fine in the browser. Only `@clausecite/core` must stay type-only.)

- [ ] **Step 3: Implement the components**

`apps/web/src/components/citation-chip.tsx`:
```tsx
export function CitationChip({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Source ${n}`}
      onClick={onClick}
      className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-sky-100 px-1 align-baseline text-xs font-semibold text-sky-800 hover:bg-sky-200 dark:bg-sky-900/50 dark:text-sky-200"
    >
      {n}
    </button>
  );
}
```

`apps/web/src/components/assistant-message.tsx`:
```tsx
'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { linkifyCitations } from '@/lib/citations';
import type { ChatMeta, ClauseCiteUIMessage, SourceRef } from '@/lib/types';
import { CitationChip } from './citation-chip';

function partsOf(message: ClauseCiteUIMessage) {
  let sources: SourceRef[] = [];
  let meta: ChatMeta | undefined;
  let streamed = '';
  for (const p of message.parts) {
    if (p.type === 'data-sources') sources = p.data.sources;
    else if (p.type === 'data-meta') meta = p.data;
    else if (p.type === 'text') streamed += p.text;
  }
  return { sources, meta, streamed };
}

export function AssistantMessage({ message, onCite }: { message: ClauseCiteUIMessage; onCite: (s: SourceRef) => void }) {
  const { sources, meta, streamed } = partsOf(message);
  const text = meta?.answer ?? streamed;
  const valid = new Set(meta ? meta.citations.map((c) => c.n) : sources.map((s) => s.n));
  const bySourceN = new Map(sources.map((s) => [s.n, s]));

  return (
    <div className="space-y-2">
      {meta?.status === 'refused' ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium">Not found in the selected policies</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">{text.split('\n')[0]}</p>
          {meta.suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="text-xs text-zinc-500">Closest clauses:</span>
              {meta.suggestions.map((s) => (
                <button key={s.chunkId} type="button" onClick={() => onCite(s)} className="rounded border px-2 py-0.5 text-xs hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900">
                  {s.documentTitle} · {s.clauseId}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                const m = /^#cite-(\d+)$/.exec(href ?? '');
                const source = m ? bySourceN.get(Number(m[1])) : undefined;
                if (m && source) return <CitationChip n={Number(m[1])} onClick={() => onCite(source)} />;
                return (
                  <a href={href} target="_blank" rel="noreferrer noopener">
                    {children}
                  </a>
                );
              },
            }}
          >
            {linkifyCitations(text, valid)}
          </ReactMarkdown>
        </div>
      )}
      {meta?.uncited && meta.status === 'complete' && (
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">uncited</span>
      )}
    </div>
  );
}
```
(`prose` classes need `@tailwindcss/typography`. Add it as a web devDependency and register it in `globals.css` with `@plugin '@tailwindcss/typography';`.)

`apps/web/src/components/policy-scope.tsx`: a client component with:
- a `<details>` dropdown summarizing "All policies" or "N policies"
- an "All policies" radio that sets `undefined`
- a checkbox per ready document; toggling builds the id list, and an empty or all-selected list collapses to `undefined`

`apps/web/src/components/chat-view.tsx`:
```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, parseApiErrorMessage } from '@/lib/api';
import { createChatTransport } from '@/lib/chat-transport';
import { ensureSession } from '@/lib/session';
import type { ClauseCiteUIMessage, PublicDocument, SourceRef } from '@/lib/types';
import { AssistantMessage } from './assistant-message';
import { PolicyScope } from './policy-scope';

export function ChatView({ onSelectSource }: { onSelectSource?: (s: SourceRef) => void }) {
  const [documents, setDocuments] = useState<PublicDocument[]>([]);
  const [scope, setScope] = useState<string[] | undefined>();
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<SourceRef | null>(null);
  const state = useRef<{ conversationId?: string; documentIds?: string[] }>({});
  state.current.documentIds = scope;

  const transport = useMemo(() => createChatTransport(() => state.current), []);
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat<ClauseCiteUIMessage>({
    transport,
    onData: (part) => {
      if (part.type === 'data-sources') state.current.conversationId = part.data.conversationId;
    },
  });

  useEffect(() => {
    ensureSession()
      .then(() => apiFetch<PublicDocument[]>('/documents'))
      .then(setDocuments)
      .catch(() => setDocuments([]));
  }, []);

  const busy = status === 'submitted' || status === 'streaming';
  const cite = (s: SourceRef) => (onSelectSource ? onSelectSource(s) : setSelected(s));
  const err = error ? parseApiErrorMessage(error.message) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <PolicyScope documents={documents.filter((d) => d.status === 'ready')} value={scope} onChange={setScope} />
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            state.current.conversationId = undefined;
            clearError();
          }}
          className="rounded border px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          New chat
        </button>
      </div>

      <div className="space-y-6">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Ask about waiting periods, exclusions, room-rent limits or definitions — every answer cites the clause and page.
          </p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="ml-auto max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
              {m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
            </div>
          ) : (
            <AssistantMessage key={m.id} message={m} onCite={cite} />
          ),
        )}
      </div>

      {err && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {err.retryAfterSeconds ? `You've hit the limit — try again in ${err.retryAfterSeconds}s.` : err.text}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          clearError();
          void sendMessage({ text });
          setInput('');
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What is the waiting period for cataract surgery?"
          maxLength={2000}
          disabled={busy}
          className="flex-1 rounded-md border px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {busy ? (
          <button type="button" onClick={() => void stop()} className="rounded-md border px-4 py-2 text-sm dark:border-zinc-700">
            Stop
          </button>
        ) : (
          <button type="submit" className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
            Ask
          </button>
        )}
      </form>

      {!onSelectSource && selected && (
        <aside className="rounded-md border p-3 text-sm dark:border-zinc-800">
          <p className="font-medium">
            {selected.documentTitle} — clause {selected.clauseId} (p. {selected.pageStart})
          </p>
          <p className="mt-2 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{selected.content}</p>
        </aside>
      )}
    </div>
  );
}
```
`apps/web/src/app/page.tsx`: `'use client'` page rendering `<ChatView />` under a heading "Ask your policy".

- [ ] **Step 4: Verify**

Run: `pnpm --filter @clausecite/web test && pnpm --filter @clausecite/web typecheck && pnpm --filter @clausecite/web build && pnpm lint && pnpm format:check`
Expected: PASS.

Manual (needs compose infra, worker, API, at least one ready document, and a real OpenRouter key): open http://localhost:3000 and ask "What is the waiting period for cataract?". Expected:
- the answer streams in
- `[1]` chips appear and open the source aside
- after `finish`, the text switches to the cleaned `meta.answer` (identical apart from removed invalid markers)
- asking "helicopter evacuation abroad?" shows the refusal callout with clause buttons

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): streaming cited chat with policy scope, citation chips, refusal suggestions, limit messages

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 6: Citation panel and PDF viewer with passage highlight

**Files:**
- Create: `apps/web/src/components/citation-panel.tsx`, `apps/web/src/components/pdf-viewer.tsx`, `apps/web/src/lib/highlight.ts`
- Modify: `apps/web/src/app/page.tsx` (two-column layout: chat left, `CitationPanel` right on ≥ lg; a slide-over drawer on mobile), `apps/web/src/components/chat-view.tsx` (remove the temporary `<aside>`; always use `onSelectSource`)
- Test: `apps/web/src/lib/highlight.spec.ts`, `apps/web/src/components/citation-panel.spec.tsx`

**Interfaces:**
- `makeHighlighter(passage: string): (text: string) => string`:
  - returns a pdf.js `customTextRenderer`-compatible function
  - HTML-escapes the item text
  - wraps it in `<mark>` when the normalized text item (lowercase, collapsed whitespace, ≥ 4 chars) occurs in the normalized passage
  - otherwise returns only the escaped text
- `<CitationPanel source={SourceRef | null} onClose />`:
  - shows document title, insurer, clause id, section path (joined with ` › `), page range, and the clause text (whitespace preserved)
  - an "Open PDF at page N" button toggles `<PdfViewer documentId page highlight />` below
- `<PdfViewer documentId page passage />`:
  - a client component loaded with `next/dynamic` (`ssr: false`)
  - react-pdf `Document` with `file={{ url: ${API_URL}/documents/${id}/file, httpHeaders: { Authorization: Bearer … } }}` (the token comes from `ensureSession()` before rendering)
  - `Page pageNumber={page}` with `customTextRenderer={({ str }) => highlighter(str)}` and the text layer enabled
  - prev/next page buttons constrained to `[1, numPages]`
  - a loading and an error state
  - the pdf.js worker is configured once: `pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`
  - imports `react-pdf/dist/Page/TextLayer.css` and `AnnotationLayer.css`

- [ ] **Step 1: Failing tests**

`apps/web/src/lib/highlight.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { makeHighlighter } from './highlight';

describe('makeHighlighter', () => {
  const h = makeHighlighter('C.3 Specified Disease Waiting Period\nThe following procedures are covered only after 24 months');
  it('marks text items that occur in the passage (case/whitespace-insensitive)', () => {
    expect(h('covered only after 24   MONTHS')).toBe('<mark>covered only after 24   MONTHS</mark>');
  });
  it('escapes HTML and leaves unrelated items unmarked', () => {
    expect(h('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(h('Ambulance cover')).toBe('Ambulance cover');
  });
  it('ignores tiny fragments to avoid noise', () => {
    expect(h('the')).toBe('the');
  });
});
```
`apps/web/src/components/citation-panel.spec.tsx`: render `CitationPanel` with a SourceRef and assert:
- the title, `clause C.3`, `Section C: Exclusions › C.3 …` and the `p. 3` texts appear
- clicking "Open PDF at page 3" renders the viewer container (mock `./pdf-viewer` with `vi.mock` to a stub `<div data-testid="pdf-viewer" data-page={page} />`)
- Close calls `onClose`

Run → FAIL.

- [ ] **Step 2: Implement**

`apps/web/src/lib/highlight.ts`:
```ts
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function makeHighlighter(passage: string): (text: string) => string {
  const haystack = normalize(passage);
  return (text: string) => {
    const escaped = escapeHtml(text);
    const needle = normalize(text);
    return needle.length >= 4 && haystack.includes(needle) ? `<mark>${escaped}</mark>` : escaped;
  };
}
```

`apps/web/src/components/pdf-viewer.tsx`:
```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { API_URL } from '@/lib/config';
import { makeHighlighter } from '@/lib/highlight';
import { ensureSession } from '@/lib/session';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export default function PdfViewer({ documentId, page, passage }: { documentId: string; page: number; passage: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>();
  const [current, setCurrent] = useState(page);
  const highlighter = useMemo(() => makeHighlighter(passage), [passage]);

  useEffect(() => setCurrent(page), [page]);
  useEffect(() => {
    void ensureSession().then((s) => setToken(s.token));
  }, []);

  const file = useMemo(
    () => (token ? { url: `${API_URL}/documents/${documentId}/file`, httpHeaders: { Authorization: `Bearer ${token}` } } : null),
    [documentId, token],
  );
  if (!file) return <p className="text-sm text-zinc-500">Loading PDF…</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <button type="button" disabled={current <= 1} onClick={() => setCurrent((p) => p - 1)} className="rounded border px-2 py-0.5 disabled:opacity-40 dark:border-zinc-700">
          ‹ Prev
        </button>
        <span>
          Page {current} {numPages ? `of ${numPages}` : ''}
        </span>
        <button type="button" disabled={!numPages || current >= numPages} onClick={() => setCurrent((p) => p + 1)} className="rounded border px-2 py-0.5 disabled:opacity-40 dark:border-zinc-700">
          Next ›
        </button>
      </div>
      <Document
        file={file}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        loading={<p className="text-sm text-zinc-500">Loading PDF…</p>}
        error={<p className="text-sm text-red-600">Could not load the PDF.</p>}
      >
        <Page pageNumber={current} width={520} customTextRenderer={({ str }) => highlighter(str)} />
      </Document>
    </div>
  );
}
```

`apps/web/src/components/citation-panel.tsx`:
```tsx
'use client';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { SourceRef } from '@/lib/types';

const PdfViewer = dynamic(() => import('./pdf-viewer'), { ssr: false, loading: () => <p className="text-sm text-zinc-500">Loading viewer…</p> });

export function CitationPanel({ source, onClose }: { source: SourceRef | null; onClose: () => void }) {
  const [showPdf, setShowPdf] = useState(false);
  if (!source) return null;
  const pages = source.pageStart === source.pageEnd ? `p. ${source.pageStart}` : `pp. ${source.pageStart}–${source.pageEnd}`;
  return (
    <aside className="space-y-3 rounded-lg border p-4 text-sm dark:border-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{source.documentTitle}</p>
          <p className="text-zinc-500">
            {source.insurer} · clause {source.clauseId} · {pages}
          </p>
          {source.sectionPath.length > 0 && <p className="mt-1 text-xs text-zinc-500">{[...source.sectionPath, source.clauseId].join(' › ')}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900">
          ×
        </button>
      </div>
      <p className="whitespace-pre-wrap leading-relaxed">{source.content}</p>
      <button type="button" onClick={() => setShowPdf((v) => !v)} className="rounded border px-3 py-1.5 dark:border-zinc-700">
        {showPdf ? 'Hide PDF' : `Open PDF at page ${source.pageStart}`}
      </button>
      {showPdf && <PdfViewer key={source.chunkId} documentId={source.documentId} page={source.pageStart} passage={source.content} />}
    </aside>
  );
}
```
(In the spec, mock `next/dynamic` to render the imported module synchronously, or mock `./pdf-viewer` and assert on the `dynamic` loader's fallback. Choose whichever is deterministic in jsdom and document it in the test.)

`apps/web/src/app/page.tsx`: hold `selected` state. Render `<ChatView onSelectSource={setSelected} />` in `lg:col-span-3` and `<CitationPanel source={selected} onClose={() => setSelected(null)} />` in a sticky `lg:col-span-2` column. On small screens the panel renders as a fixed bottom sheet (`fixed inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto bg-white dark:bg-zinc-950`) when a source is selected.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @clausecite/web test && pnpm --filter @clausecite/web typecheck && pnpm --filter @clausecite/web build && pnpm lint && pnpm format:check`
Expected: PASS. The build output must not include pdf.js in the server bundle; `ssr: false` takes care of that.

Manual: in the dev stack, click a citation chip. The panel shows the clause. "Open PDF at page 3" renders page 3 of the fixture with the C.3 passage highlighted in `<mark>`, and Prev/Next work.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): citation panel with authenticated pdf viewer and passage highlighting

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
### Task 7: Real policy data: sources manifest, download with lockfile, bulk ingest through the API

**Files:**
- Create: `data/sources.json` (**content supplied by the controller in the dispatch: the user-approved list**), `scripts/download-sources.ts`, `scripts/ingest-sources.ts`, `scripts/lib/sources.ts`
- Create (generated by running the download): `data/sources.lock.json` (committed)
- Modify: root `package.json` scripts `"sources:download": "node scripts/download-sources.ts"` and `"sources:ingest": "node --env-file-if-exists=.env scripts/ingest-sources.ts"`; `.gitignore` already ignores `data/pdfs/`
- Test: `scripts/lib/sources.spec.ts`, run by a new root `vitest.config.ts` project `scripts` (include `scripts/**/*.spec.ts`), wired into the root `test` script as `turbo run test && vitest run --project scripts` (or an equivalent root-level step)

**Interfaces:**
- `sourcesSchema` (zod): an array of `{ slug: /^[a-z0-9-]{3,80}$/, insurer, product, title, policy_type: 'health', uin?: string, url: https URL }` with unique slugs.
- `lockSchema`: an array of `{ slug, url, sha256: /^[0-9a-f]{64}$/, bytes: number, retrievedAt: ISO string }`.
- `download-sources`, for each source:
  - fetches the URL with a browser-like `User-Agent` **and `Accept-Language: en-IN,en;q=0.9`** (icicilombard.com and careinsurance.com return 403 without them), `redirect: 'follow'` and a 60 s timeout
  - checks the bytes, not the status: some insurer sites return HTTP 200 with an HTML page for wrong paths, which the `%PDF-` check catches
  - rejects a non-200 status, a body that doesn't start with `%PDF-`, or a body over 20 MB
  - writes `data/pdfs/sources/<slug>.pdf`
  - records sha256 and bytes
  - writes `data/sources.lock.json` sorted by slug
  - a failure on one source is reported and skipped, and the exit code is 1 if any failed
  - an existing file whose sha matches the lock is skipped (idempotent)
- `ingest-sources`:
  - logs in with `ADMIN_EMAIL`/`ADMIN_PASSWORD` against `API_URL` (default `http://localhost:3001`)
  - uploads each locked PDF as multipart (`file` with type `application/pdf`, plus `slug`, `title`, `insurer`, `product`, `policy_type`); 201 and 200 (dedupe) are both success, 409 means the slug was taken by different bytes and is reported
  - polls `GET /documents` every 5 s until every uploaded slug is `ready` or `failed` (timeout 15 min)
  - prints a table (slug, status, pages, chunks, error) and exits 1 if any failed

- [ ] **Step 1: Write `data/sources.json`** exactly as provided in the dispatch (the user-approved list). Do not add or remove entries.

- [ ] **Step 2: Failing tests** for the pure helpers in `scripts/lib/sources.ts`:
  - `parseSources(json)` accepts a valid manifest and rejects duplicate slugs, a non-https URL and a bad slug
  - `isPdf(bytes)` is true only for buffers starting with `%PDF-`
  - `sha256Hex(bytes)` returns a known value
  - `mergeLock(existing, entry)` replaces an entry by slug and keeps the result sorted

- [ ] **Step 3: Implement** `scripts/lib/sources.ts` (zod schemas + helpers) and the two scripts. The ingest script uses `fetch` + `FormData` + `new Blob([bytes], { type: 'application/pdf' })` (Node ≥ 22 globals). Never print the admin password or the token.

- [ ] **Step 4: Run it for real** (the user approved downloading these public documents):
```bash
pnpm sources:download
```
Expected: `data/pdfs/sources/*.pdf` exist, and `data/sources.lock.json` lists every downloaded slug with sha256 and bytes. If some URLs fail, report them (don't substitute different documents without controller approval).

Then, with compose infra, worker and API running, and a valid `ADMIN_PASSWORD` set by the user in `.env`:
```bash
pnpm sources:ingest
```
Expected: all documents reach `ready`. Embedding cost is about $0.02. If `ADMIN_PASSWORD` is still the placeholder (admin seeding is skipped), stop and report NEEDS_CONTEXT. Do not edit the user's password.

- [ ] **Step 5: Verify and commit** (`data/pdfs/` must not be staged; check `git status`):
```bash
pnpm test && pnpm lint && pnpm format:check
git add data/sources.json data/sources.lock.json scripts package.json vitest.config.ts
git commit -m "feat(data): approved public policy sources, reproducible download lockfile, bulk ingest script

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 8: Production images, Compose stack and Caddy

**Files:**
- Create: `.dockerignore`, `docker/node-app.Dockerfile` (builds `api` or `worker` via `--build-arg APP=api|worker`), `docker/web.Dockerfile`, `docker-compose.prod.yml`, `docker/Caddyfile`, `.env.prod.example`
- Modify: `packages/core/package.json`: move `testcontainers` and `@testcontainers/postgresql` from `dependencies` to `devDependencies`. They are needed only by `@clausecite/core/testing`, which is test-only; pnpm still installs workspace devDependencies locally, and `--prod` deploys drop them.
- Test: `scripts/verify-prod-stack.sh` (a smoke script; see Step 4)

**Interfaces / requirements:**
- Images:
  - `ghcr.io/<owner>/clausecite-api`, `…-worker` and `…-web`, tagged with `IMAGE_TAG` (git sha) and `latest`
  - base image `node:24-bookworm-slim` (argon2 prebuilt binaries)
  - non-root `node` user
  - no `.env`, tests or devDependencies in runtime layers
- `node-app.Dockerfile` stages:
  - `deps`: `pnpm fetch` with the lockfile
  - `build`: `pnpm install --offline --frozen-lockfile`, then `pnpm turbo run build --filter=@clausecite/${APP}...`, then `pnpm --filter @clausecite/${APP} deploy --legacy --prod /out`
  - `runtime`: copy `/out`; `WORKDIR /app`; `CMD ["node","dist/main.js"]`
  - The API image also includes core's `drizzle/` migrations, because `deploy` copies `@clausecite/core` with its `files: ["dist","drizzle"]`. Verify `node_modules/@clausecite/core/drizzle` exists in the image.
- `web.Dockerfile`:
  - `ARG NEXT_PUBLIC_API_URL=/api` (baked at build time)
  - builds with `pnpm turbo run build --filter=@clausecite/web...`
  - runtime copies `.next/standalone`, `.next/static` and `public` (create an empty `apps/web/public/.gitkeep` if missing)
  - `CMD ["node","apps/web/server.js"]`, with `PORT=3000` and `HOSTNAME=0.0.0.0`
- `docker-compose.prod.yml` (no host ports except Caddy 80/443):
  - `postgres` (`pgvector/pgvector:pg17`, volume `pgdata`, healthcheck)
  - `rabbitmq` (`rabbitmq:3.13-management-alpine`, volume `rabbitdata`, healthcheck; the management UI is not exposed)
  - `redis` (`redis:7-alpine`, `--appendonly yes`, volume)
  - `redis-cache` (`--maxmemory 256mb --maxmemory-policy allkeys-lru --save "" --appendonly no`)
  - `migrate`: api image, `command: ["node","node_modules/@clausecite/core/dist/db/migrate.js"]`, `restart: "no"`, depends on postgres healthy
  - `api`: depends on `migrate` completed successfully, postgres/redis/redis-cache healthy, and rabbitmq started; healthcheck `node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`; `stop_grace_period: 75s`, longer than the 60 s chat stream
  - `worker`: `stop_grace_period: 40s`, longer than the 30 s drain
  - `web`
  - `caddy` (`caddy:2-alpine`, ports `80:80`, `443:443`, `443:443/udp`, volumes `caddy_data` and `caddy_config`, mounts `./docker/Caddyfile`)
  - `backup`: `pgvector/pgvector:pg17` running `sh -c 'while true; do pg_dump -Fc "$DATABASE_URL" > /backups/clausecite-$(date +%F).dump && find /backups -name "*.dump" -mtime +7 -delete; sleep 86400; done'`, volume `./backups:/backups`
  - Shared env via `env_file: .env.prod` plus explicit `environment:` overrides:
    - `DATABASE_URL=postgres://clausecite:${POSTGRES_PASSWORD}@postgres:5432/clausecite`
    - `RABBITMQ_URL=amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@rabbitmq:5672?heartbeat=30`
    - `REDIS_URL=redis://redis:6379`
    - `CACHE_REDIS_URL=redis://redis-cache:6379`
    - `STORAGE_DIR=/data/pdfs` (named volume `pdfs` mounted in **both** api and worker)
    - `TRUST_PROXY_HOPS=1`
    - `WEB_ORIGIN=https://${DOMAIN}`
    - `PORT=3001`
- `docker/Caddyfile`:
```caddyfile
{$DOMAIN:localhost} {
	encode zstd gzip
	handle_path /api/* {
		reverse_proxy api:3001 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy web:3000
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
```
- `.env.prod.example` lists every production variable with comments and **empty secret values**:
  - `DOMAIN`, `POSTGRES_PASSWORD`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`
  - `OPENROUTER_API_KEY` and the model overrides
  - `JWT_SECRET` (with the `openssl rand -base64 48` hint), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥ 12)
  - `GUEST_DAILY_TOKEN_BUDGET`, `GLOBAL_DAILY_TOKEN_BUDGET`, `SEARCH_TOKEN_COST`
  - `INGEST_RETRY_DELAYS_MS`
  - `IMAGE_TAG`, `GHCR_OWNER`
- `.dockerignore` excludes `**/node_modules`, `**/dist`, `**/.next`, `.env*` (but not `.env.prod.example`), `data/pdfs`, `backups`, `.git`, `.superpowers`, `docs`, `**/*.spec.ts`, `**/test`.

- [ ] **Step 1: Move testcontainers to devDependencies** in core. Then run `pnpm install && pnpm build && pnpm test:int` to confirm the integration suites still resolve `@clausecite/core/testing`.

- [ ] **Step 2: Write the Dockerfiles, compose file, Caddyfile, `.env.prod.example` and `.dockerignore`** per the requirements above.

- [ ] **Step 3: Build the images locally**
```bash
docker build -f docker/node-app.Dockerfile --build-arg APP=api -t clausecite-api:local .
docker build -f docker/node-app.Dockerfile --build-arg APP=worker -t clausecite-worker:local .
docker build -f docker/web.Dockerfile -t clausecite-web:local .
docker run --rm clausecite-api:local ls node_modules/@clausecite/core/drizzle
docker run --rm clausecite-api:local sh -c 'ls node_modules | grep -c testcontainers || true'
```
Expected:
- the three builds succeed
- the drizzle folder lists the migrations
- the testcontainers count is `0`
- image sizes are reported in the task report

- [ ] **Step 4: Smoke-test the whole stack locally.** `scripts/verify-prod-stack.sh`:
  - creates a throwaway `.env.prod.local`
    - random passwords via `openssl rand`
    - `DOMAIN=localhost`
    - the real `OPENROUTER_API_KEY`, read from `.env` with `grep` without echoing it
    - a random `JWT_SECRET` and `ADMIN_PASSWORD`
  - runs `IMAGE_TAG=local docker compose -f docker-compose.prod.yml --env-file .env.prod.local up -d`; for the local smoke the compose file must accept `image: ${GHCR_OWNER:-local}/clausecite-api:${IMAGE_TAG}` or a `docker-compose.local-images.yml` override that points at the `:local` tags
  - waits up to 120 s, then checks:
    - `curl -sk https://localhost/api/health` → 200 with all checks true
    - `curl -sk https://localhost/` → HTML containing `ClauseCite`
    - `curl -sk -X POST https://localhost/api/auth/guest` → 201
  - runs `docker compose … down -v`
  - deletes `.env.prod.local`
  - exits non-zero on any failed check

  Run it. Expected: `prod stack OK`. It makes no paid model calls.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat(deploy): production images, compose stack with caddy, backups, prod env template

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 9: CI and deploy workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `docs/deploy.md`

**Requirements:**
- `ci.yml`:
  - triggers: `push` to any branch and `pull_request`
  - `ubuntu-latest`, Node 24 via `actions/setup-node` with pnpm cache, `corepack enable`
  - steps: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`, `pnpm test:int` (Docker is available on GitHub-hosted runners for Testcontainers)
  - `concurrency: ci-${{ github.ref }}` with cancel-in-progress
  - timeout 30 min
  - no secrets needed: all tests use mock models
- `deploy.yml`:
  - triggers: `workflow_run` of CI on `main` with `conclusion == 'success'`, plus `workflow_dispatch`
  - job condition: `if: vars.DEPLOY_ENABLED == 'true'`, so the workflow is a no-op until the user configures it
  - permissions: `contents: read`, `packages: write`
  - steps:
    - log in to GHCR with `GITHUB_TOKEN`
    - build and push the three images with `docker/build-push-action`, tags `ghcr.io/${{ github.repository_owner }}/clausecite-<app>:${{ github.sha }}` and `:latest`, with GHA build cache
    - copy `docker-compose.prod.yml` and `docker/Caddyfile` to `${{ vars.DEPLOY_PATH || '/opt/clausecite' }}` on the server over SSH (key from `secrets.DEPLOY_SSH_KEY`, host from `secrets.DEPLOY_HOST`, user from `secrets.DEPLOY_USER`; write the key to a 0600 file and add `ssh-keyscan` output to known_hosts)
    - run on the server: `IMAGE_TAG=<sha> docker compose -f docker-compose.prod.yml --env-file .env.prod pull && … up -d --remove-orphans`
    - smoke step: `curl -fsS https://${{ vars.DOMAIN }}/api/health`, retried for up to 3 minutes
  - never echo secrets
- `docs/deploy.md`: the step-by-step guide for the user:
  - provision a VM (2 vCPU / 4 GB; Hetzner CX22 or Lightsail), point a DNS A record at it
  - install Docker, create `/opt/clausecite` with `.env.prod` from `.env.prod.example`
  - GHCR pull access (make the packages public, or `docker login ghcr.io` on the VM with a read-only PAT)
  - GitHub settings: secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`; variables `DEPLOY_ENABLED=true`, `DOMAIN`, `DEPLOY_PATH`
  - first ingest (run `pnpm sources:ingest` locally with `API_URL=https://<domain>/api`)
  - **set an OpenRouter credit limit on the key** (DECISIONS 012)
  - backups and restore (`pg_restore -d …`)
  - a note that a PgBouncer in transaction mode would reject the `options` startup parameter (DECISIONS / Phase 1A Task 2)
  - rotating `JWT_SECRET` (logs everyone out)

- [ ] **Step 1: Write the workflows and docs.**
- [ ] **Step 2: Validate the workflow syntax locally** with `npx --yes @action-validator/cli .github/workflows/ci.yml` and the same for `deploy.yml`. If that tool is unavailable, use `actionlint` via `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest`. Expected: no errors.
- [ ] **Step 3: Commit**
```bash
git add -A
git commit -m "ci: lint/typecheck/unit/integration workflow and gated ghcr + ssh deploy workflow

Co-Authored-By: <model> <noreply@anthropic.com>"
```
(The controller pushes after the final review. CI then runs on GitHub; check its result there.)

---

### Task 10: README and docs

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-10-03-clausecite-design.md` (Status line → "Phase 1 implemented; Phase 2 pending"; point §5 `/chat` at DECISIONS 010)

**Requirements** (portfolio-quality, honest, no invented numbers):
1. Title + one-line pitch + a 3-bullet "What it does".
2. **Architecture**: a Mermaid diagram (browser → Caddy → web/api; api ↔ Postgres+pgvector, Redis, redis-cache, RabbitMQ → worker; api/worker → OpenRouter), plus a short request-flow walkthrough of the ingest path and the ask path.
3. **How retrieval works**: structure-aware chunking, hybrid pgvector + full-text with RRF, Cohere rerank, refusal gate, citation validation. Link the relevant DECISIONS entries (002, 003, 006, 007, 009, 010).
4. **Engineering highlights** worth an interviewer's attention (each one line, with the file path):
   - per-delay retry queues
   - row lock against duplicate chunks
   - `dist + 0` exact ranking under relaxed HNSW
   - prompt-injection escaping
   - fail-closed limits with global spend cap
   - crash-only worker vs reconnecting API publisher
5. **Tech stack** table.
6. **Run it locally**: prerequisites (Node ≥ 22.12, pnpm via corepack, Docker); `cp .env.example .env` and which values to fill (OpenRouter key, `JWT_SECRET` via openssl, `ADMIN_PASSWORD` ≥ 12); `pnpm install`, `pnpm infra:up`, `pnpm db:migrate`, `pnpm build`; run worker/api/web; `pnpm sources:download && pnpm sources:ingest`; open http://localhost:3000.
7. **Testing**: `pnpm test`, `pnpm test:int` (Docker), what they cover, plus the approximate test counts **measured by running them** (state the numbers you observed).
8. **Deploying**: link `docs/deploy.md`.
9. **Roadmap**: Phase 2 (eval harness with Recall@k/faithfulness/citation precision in CI, agent mode, MCP server, Langfuse tracing). State that metrics will be published from the eval reports.
10. **Data notice**: the policy wordings belong to their insurers and are used for demonstration only; answers are not insurance advice.

- [ ] **Step 1: Write the README.** Render the Mermaid block mentally for syntax: use `flowchart LR`, quoted labels and no parentheses inside unquoted labels.
- [ ] **Step 2: Run `pnpm test && pnpm test:int` once** to report real counts in the README. Then run `pnpm format:check`.
- [ ] **Step 3: Commit**
```bash
git add -A
git commit -m "docs: readme with architecture, retrieval design, local run, testing and deploy guides

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Plan self-review checklist (run after Task 10)

- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm test:int` is green from a clean clone.
- [ ] `grep -rn "from '@clausecite/core'" apps/web/src | grep -v "import type\|export type"` prints nothing.
- [ ] `git ls-files | grep -E '^data/pdfs|\.env$|\.env\.prod$'` prints nothing.
- [ ] DECISIONS 011 and 012 are marked resolved/implemented. The OpenRouter credit-limit step is in `docs/deploy.md`.
