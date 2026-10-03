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
