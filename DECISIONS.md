# Architecture Decisions

Short records of choices that refine or deviate from the design spec, with the reason.

## 001 — One retry queue per delay

**Context:** spec §3.6 described one retry queue with per-message TTL (10 s / 60 s / 300 s).
**Decision:** create `ingest.document.retry.<ms>` per delay with a queue-level `x-message-ttl`, dead-lettering back to `ingest`.
**Why:** RabbitMQ only expires messages at the head of a queue; a 300 s message would block 10 s retries behind it.

## 002 — Index-friendly hybrid SQL

**Decision:** run `ORDER BY embedding <=> $q LIMIT k` in an inner subquery and compute `row_number()` outside it.
**Why:** a window function over the whole table forces a sequential scan and bypasses the HNSW index.

## 003 — List markers are body text

**Decision:** `(i)`, `(a)` stay inside their clause instead of becoming clauses.
**Why:** splitting enumerations from their lead-in sentence destroys the context needed to answer coverage questions.

## 004 — Plain amqplib with a crash-only worker

**Decision:** use `amqplib` confirm channels behind `packages/core/src/queue`; on connection loss the worker exits and Docker restarts it.
**Why:** explicit, testable topology; reconnect logic is the supervisor's job.

## 005 — File paths are stored as names

**Decision:** `documents.file_path` stores `<sha256>.pdf`; each app resolves it against its own `STORAGE_DIR`.
**Why:** API and worker run with different working directories locally and share a volume in Docker.
**Consequence:** `STORAGE_DIR` is required in both apps (no default): a cwd-relative fallback would silently resolve to different directories for the API and the worker.

## 006 — Lock the document row during chunk replace

**Decision:** `SELECT … FOR UPDATE` on the document row as the first statement of the replace transaction.
**Why:** with worker prefetch > 1 or a redelivery overlapping a running job, two ingests of the same document could interleave delete/insert and duplicate chunks (reproduced in a test: 12 vs 6 chunks).

## 007 — Heading detection is gated against body text

**Decision:** `Section/Part` lines need a strong font or a short capitalised unpunctuated title; numbered lines need a strong font or a capitalised word after the id; numeric parts > 99 and list markers are never headings.
**Why:** insurance wording is full of cross-references ("Section 45 of the Insurance Act…") and wrapped numbers ("1.5 times the sum insured…") that otherwise become fake clauses and drop limits from the real clause text.

## 008 — Admin seeded on boot; stateless JWTs; API key deferred

**Decision:** the API seeds the admin from env on bootstrap (idempotent, email lowercased, refuses the placeholder and passwords under 12 characters with a warning instead of crashing); guest/admin JWTs (HS256 pinned, 24 h / 12 h) are trusted without a DB lookup; machine API-key auth arrives with the MCP server in Phase 2.
**Why:** no separate seed step for a one-admin demo; stateless auth keeps the hot path off the DB; YAGNI for API keys until a consumer exists.
**Consequence:** a deleted user's token stays valid until expiry; writes keyed by `sub` must tolerate FK failures.

## 009 — Embedding cache on its own bounded Redis

**Decision:** cache query embeddings in a dedicated `redis-cache` instance (`--maxmemory 256mb --maxmemory-policy allkeys-lru`, no persistence), configured via `CACHE_REDIS_URL` (falls back to `REDIS_URL` when unset); entries are base64 float32 vectors (about 8 KB), written fire-and-forget with a 1 s command timeout.
**Why:** cache keys come from user queries and live for 7 days, so enough unique queries could exhaust the Redis that also holds the fail-closed rate limits and token budgets; turning on `allkeys-lru` on that shared instance would instead let eviction drop budget and limit keys.
**Consequence:** one more container; the production compose file (Phase 1B) must mirror it. A cache outage only costs a re-embed.

## 010 — Chat request carries one message; the server owns history

**Context:** spec §5 listed `messages` (the whole transcript) in the `/chat` request.
**Decision:** the API takes `{ conversationId?, message, documentIds?, mode }` and reloads the history from Postgres (sanitized: citation markers stripped, roles alternating). The web client will send only the new message through the AI SDK transport's `prepareSendMessagesRequest`.
**Why:** the client cannot inject or rewrite history, and citations are validated against sources the server itself retrieved.
**Consequence:** Phase 1B web work must configure `prepareSendMessagesRequest` (send the last user message plus `conversationId`); the stream's final `data-meta` carries the validated `answer` and a refusal's `suggestions` so the UI does not depend on the raw deltas.
Scope is per request: omitting documentIds searches all policies, even mid-conversation.

## 011 — API currently crash-only on broker loss (resolved in Phase 1B)

**Context:** the API reuses `connectRabbit`'s crash-only `onClose` (decision 004), but unlike the worker it needs the broker only for uploads and re-ingest.
**Problem:** a broker restart kills in-flight chat streams, and the API crash-loops for as long as the broker is down, taking `/chat` and `/search` with it.
**Planned (Phase 1B):** log the close instead of exiting, report `rabbitmq: false` on `/health`, reconnect lazily on publish and answer `503` if that fails.
**Resolution:** the API now uses a lazy, reconnecting `RabbitPublisher`; it boots and serves chat/search without the broker, `/health` reports `rabbitmq: false`, uploads return 503 until the broker is back. The worker remains crash-only.

## 012 — Spend protection is a Phase 1B deploy gate (implemented)

**Context:** per-user daily token budgets and per-user/per-IP rate limits existed (fail closed on Redis errors), but nothing bounded the total spend of the deployment, and search and refusals were free to spam up to the rate limit.
**Implemented:**

- **Global daily cap:** `GLOBAL_DAILY_TOKEN_BUDGET` (default 2,000,000) on Redis key `budget:global:<utc-day>`. Every role counts toward it (admins included) and `assertBudget` checks it before anything else, for admins too; once spent, `/chat` and `/search` answer 429 `Service daily budget exhausted` with `Retry-After` until UTC midnight. Fail closed: a Redis error or a non-numeric counter rejects the request.
- **Nominal charges:** `SEARCH_TOKEN_COST` (default 300) is recorded for every `/search` call (refusals and retrieval errors included) and for every chat that reaches retrieval and completes or refuses, on top of the rewrite and model tokens. Guests are charged on both their own and the global counter, admins on the global counter only.
- **IPv6 `/64` buckets:** every IP rate-limit bucket is keyed by `clientIpKey(req.ip)`: IPv4 as-is, IPv4-mapped IPv6 as the IPv4 address, any other IPv6 address by its first four hextets (`2001:db8:abcd:12::/64`), anything unparsable as `unknown`.
- **`TRUST_PROXY_HOPS`** (default `0`) drives Express `trust proxy`. `0` means `req.ip` is the socket address and `X-Forwarded-For` is ignored; production sets `1` (behind Caddy). The API test harness sets `1` because the limit e2e tests drive client IPs through `X-Forwarded-For`.

**Not covered:** a chat that fails mid-generation records the tokens it knows about but not the flat `SEARCH_TOKEN_COST` (the failure path is unchanged), so the OpenRouter key's own credit limit below is the backstop for failure-heavy abuse.
**Remaining manual step (before going public):** set a credit limit on the OpenRouter key (openrouter.ai → Keys → Edit → Credit limit). It is the only bound that does not depend on this code.
