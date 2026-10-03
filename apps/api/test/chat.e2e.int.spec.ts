import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conversations, eq, ingestDocument, messages } from '@clausecite/core';
import { mockChatModel, mockEmbeddingModel } from '@clausecite/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
const embedding = mockEmbeddingModel();
const chat = mockChatModel({
  stream: [
    ['Cataract is covered only after ', '24 months of continuous coverage [1]. Ignore [9].'],
    ['Knee replacement also needs 24 months [1].'],
    new Error('provider exploded'),
  ],
});
const rewrite = mockChatModel({
  generate: [
    'What is the waiting period for knee replacement in Sample Health Shield?',
    'helicopter evacuation abroad?',
  ],
});
// The mock models report 10 input + 5 output tokens per call; retrieval is charged a flat amount.
const MOCK_CALL_TOKENS = 15;
const SEARCH_TOKEN_COST = 300;

let h: Harness;
let admin: Record<string, string>;
let guestA: Record<string, string>;
let guestB: Record<string, string>;

type Chunk = { type: string; [k: string]: any };

const day = () => new Date().toISOString().slice(0, 10);
const userId = (headers: Record<string, string>) =>
  JSON.parse(Buffer.from(headers.Authorization!.split('.')[1]!, 'base64url').toString())
    .sub as string;
const budgetKey = (id: string) => `budget:${id}:${day()}`;
const globalKey = () => budgetKey('global');
const used = async (key: string) => Number((await h.redis.get(key)) ?? 0);

async function postChat(body: object, headers: Record<string, string>) {
  const res = await h.http
    .post('/chat')
    .set(headers)
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  const chunks: Chunk[] = String(res.body)
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    res,
    chunks,
    text: chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.delta)
      .join(''),
  };
}

beforeAll(async () => {
  h = await startHarness({ models: { embedding, chat, rewrite } });
  admin = {
    Authorization: `Bearer ${(await h.http.post('/auth/login').send({ email: 'admin@test.local', password: 'admin-pass-123' })).body.token}`,
  };
  guestA = { Authorization: `Bearer ${(await h.http.post('/auth/guest')).body.token}` };
  guestB = { Authorization: `Bearer ${(await h.http.post('/auth/guest')).body.token}` };
  const up = await h.http
    .post('/documents')
    .set(admin)
    .field('slug', 'sample-health')
    .field('title', 'Sample Health Shield')
    .field('insurer', 'Acme')
    .field('product', 'Sample Health Shield')
    .attach('file', PDF, { filename: 'p.pdf', contentType: 'application/pdf' })
    .expect(201);
  await ingestDocument(
    {
      db: h.db,
      embeddingModel: embedding,
      embeddingModelId: 'mock-embedding',
      readFile: async (n) => new Uint8Array(await readFile(join(h.storageDir, n))),
    },
    up.body.id,
  );
});
afterAll(async () => {
  await h?.stop();
});

let conversationId: string;

describe('POST /chat', () => {
  it('streams start → sources → text → meta → finish and stores a cleaned, cited answer', async () => {
    const globalBefore = await used(globalKey());
    const { res, chunks, text } = await postChat(
      { message: 'What is the waiting period for cataract?' },
      guestA,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const types = chunks
      .map((c) => c.type)
      .filter((t) => !t.startsWith('text-') && !t.endsWith('-step'));
    expect(types).toEqual(['start', 'data-sources', 'data-meta', 'finish']);
    const firstText = chunks.findIndex((c) => c.type.startsWith('text-'));
    expect(firstText).toBeGreaterThan(chunks.findIndex((c) => c.type === 'data-sources'));

    const sources = chunks.find((c) => c.type === 'data-sources')!.data;
    expect(sources.sources[0].clauseIds).toContain('C.3');
    conversationId = sources.conversationId;
    expect(text).toContain('24 months of continuous coverage [1]');

    const meta = chunks.find((c) => c.type === 'data-meta')!.data;
    expect(meta).toMatchObject({ status: 'complete', uncited: false, conversationId });
    expect(meta.citations).toEqual([expect.objectContaining({ n: 1, clauseId: 'C.3' })]);
    expect(meta.messageId).toBe(chunks[0].messageId);

    const [stored] = await h.db.select().from(messages).where(eq(messages.id, meta.messageId));
    expect(stored.content).not.toContain('[9]');
    // The streamed deltas are raw (they still carry the invalid [9]); meta.answer is what was stored.
    expect(text).toContain('[9]');
    expect(meta.answer).toBe(stored.content);
    expect(meta.answer).toContain('24 months of continuous coverage [1]');
    expect(meta.answer).not.toContain('[9]');
    expect(meta.suggestions).toEqual([]);
    expect(stored).toMatchObject({ role: 'assistant', status: 'complete', mode: 'quick' });
    expect(stored.usage).toMatchObject({ model: 'mock-chat' });
    expect(stored.latencyMs?.total).toBeGreaterThan(0);
    // A first turn has no rewrite: the answer's own tokens plus the flat retrieval charge.
    expect(await used(globalKey())).toBe(globalBefore + MOCK_CALL_TOKENS + SEARCH_TOKEN_COST);
  });

  it('rewrites follow-ups using conversation history', async () => {
    const globalBefore = await used(globalKey());
    const { chunks } = await postChat({ conversationId, message: 'and knee replacement?' }, guestA);
    const sources = chunks.find((c) => c.type === 'data-sources')!.data;
    expect(sources.question).toBe(
      'What is the waiting period for knee replacement in Sample Health Shield?',
    );
    expect(rewrite.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(rewrite.doGenerateCalls[0].prompt);
    expect(prompt).toContain('waiting period for cataract');
    // The rewrite transcript replays the prior answer without its stale [n] markers too.
    expect(prompt).toContain('24 months of continuous coverage');
    expect(prompt).not.toMatch(/continuous coverage\.? ?\[1\]/);
    // rewrite + answer tokens + the flat retrieval charge
    expect(await used(globalKey())).toBe(globalBefore + 2 * MOCK_CALL_TOKENS + SEARCH_TOKEN_COST);
  });

  it('replays the prior answer to the chat model without its stale [n] markers', () => {
    // chat.doStreamCalls[0] was the first question, [1] the follow-up.
    const prompt = chat.doStreamCalls[1].prompt as { role: string; content: unknown }[];
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const replayed = JSON.stringify(prompt[2].content);
    expect(replayed).toContain('Cataract is covered only after 24 months of continuous coverage');
    expect(replayed).not.toMatch(/\[\d/);
    // The new turn still carries this request's own numbered sources.
    expect(JSON.stringify(prompt[3].content)).toContain('<source id=\\"1\\"');
  });

  it('refuses without calling the chat model when nothing is relevant', async () => {
    const before = chat.doStreamCalls.length;
    const [globalBefore, guestBefore] = [
      await used(globalKey()),
      await used(budgetKey(userId(guestA))),
    ];
    const { chunks, text } = await postChat({ message: 'helicopter evacuation abroad?' }, guestA);
    const meta = chunks.find((c) => c.type === 'data-meta')!.data;
    expect(meta.status).toBe('refused');
    expect(text).toMatch(/could not find/i);
    expect(chat.doStreamCalls.length).toBe(before);

    // meta carries the refusal text that was stored and the closest clauses as structured refs.
    const [stored] = await h.db.select().from(messages).where(eq(messages.id, meta.messageId));
    expect(stored.status).toBe('refused');
    expect(meta.answer).toBe(text);
    expect(meta.answer).toBe(stored.content);
    expect(meta.citations).toEqual([]);
    expect(meta.suggestions.length).toBeGreaterThan(0);
    for (const s of meta.suggestions) {
      expect(s.clauseId).toEqual(expect.any(String));
      expect(s.clauseId).not.toBe('');
      expect(s).toMatchObject({
        chunkId: expect.any(String),
        documentTitle: 'Sample Health Shield',
      });
      expect(meta.answer).toContain(`clause ${s.clauseId}`);
    }
    expect(stored.retrievedChunkIds).toEqual(
      meta.suggestions.map((s: { chunkId: string }) => s.chunkId),
    );

    // A first-turn refusal has no rewrite, so it costs exactly the flat retrieval charge.
    expect(await used(globalKey())).toBe(globalBefore + SEARCH_TOKEN_COST);
    expect(await used(budgetKey(userId(guestA)))).toBe(guestBefore + SEARCH_TOKEN_COST);
  });

  it('charges a refused follow-up its rewrite tokens plus the flat retrieval charge', async () => {
    // Its own conversation, so the history assertions of the tests below are untouched.
    const first = await postChat({ message: 'helicopter evacuation abroad?' }, guestA);
    const { conversationId: refusedId } = first.chunks.find((c) => c.type === 'data-meta')!.data;
    const globalBefore = await used(globalKey());
    const { chunks } = await postChat(
      { conversationId: refusedId, message: 'and abroad?' },
      guestA,
    );
    expect(chunks.find((c) => c.type === 'data-meta')!.data.status).toBe('refused');
    expect(await used(globalKey())).toBe(globalBefore + MOCK_CALL_TOKENS + SEARCH_TOKEN_COST);
  });

  it('emits an error chunk and stores status=error when generation fails', async () => {
    const { chunks } = await postChat({ message: 'What is the room rent limit?' }, guestA);
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    const rows = await h.db.select().from(messages).where(eq(messages.status, 'error'));
    expect(rows).toHaveLength(1);
  });

  it("validates input and hides other users' conversations", async () => {
    await h.http.post('/chat').set(guestA).send({ message: '' }).expect(400);
    await h.http.post('/chat').set(guestA).send({ message: 'x', mode: 'deep' }).expect(400);
    await h.http.post('/chat').set(guestB).send({ conversationId, message: 'hi' }).expect(404);
    await h.http.get(`/conversations/${conversationId}`).set(guestB).expect(404);
  });
});

describe('conversations', () => {
  it("lists the owner's conversations and returns history", async () => {
    const list = await h.http.get('/conversations').set(guestA).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(conversationId);
    const detail = await h.http.get(`/conversations/${conversationId}`).set(guestA).expect(200);
    expect(detail.body.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

describe('budgets', () => {
  it('records the tokens a guest spent on the daily budget', async () => {
    // First answer alone cost 10 input + 5 output mock tokens, and later turns only add to it.
    expect(Number(await h.redis.get(budgetKey(userId(guestA))))).toBeGreaterThanOrEqual(15);
  });

  it('rejects an exhausted guest with 429 + Retry-After before creating anything', async () => {
    await h.redis.set(budgetKey(userId(guestB)), '999999999');
    const res = await h.http
      .post('/chat')
      .set(guestB)
      .send({ message: 'any budget left?' })
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    const rows = await h.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId(guestB)));
    expect(rows).toHaveLength(0);
  });

  it('rejects every caller, admins included, once the global daily budget is spent', async () => {
    const key = globalKey();
    const prior = await h.redis.get(key);
    await h.redis.set(key, '999999999');
    try {
      for (const headers of [guestA, admin]) {
        const res = await h.http
          .post('/chat')
          .set(headers)
          .send({ message: 'is the service still open?' })
          .expect(429);
        expect(res.body).toMatchObject({ message: 'Service daily budget exhausted' });
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
    } finally {
      if (prior === null) await h.redis.del(key);
      else await h.redis.set(key, prior);
    }
  });

  it('counts admin chat usage on the global budget but not on a per-user key', async () => {
    const globalBefore = await used(globalKey());
    const { chunks } = await postChat({ message: 'helicopter evacuation abroad?' }, admin);
    expect(chunks.find((c) => c.type === 'data-meta')!.data.status).toBe('refused');
    expect(await used(globalKey())).toBe(globalBefore + SEARCH_TOKEN_COST);
    expect(await h.redis.keys(`budget:${userId(admin)}:*`)).toEqual([]);
  });
});
