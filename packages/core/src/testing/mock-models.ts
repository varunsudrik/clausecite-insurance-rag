import { MockEmbeddingModelV4, MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { RerankError, type Reranker } from '../llm/rerank.js';

/** Deterministic bag-of-words embedding: texts sharing words get high cosine similarity. */
export function hashEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const v = Array.from({ length: dims }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts (like a real fetch). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function mockEmbeddingModel(
  fn: (text: string) => number[] = (t) => hashEmbedding(t),
  opts: { maxEmbeddingsPerCall?: number; delayMs?: number } = {},
) {
  return new MockEmbeddingModelV4({
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: opts.maxEmbeddingsPerCall ?? 100,
    doEmbed: async ({ values, abortSignal }) => {
      if (opts.delayMs) await delay(opts.delayMs, abortSignal);
      return {
        embeddings: values.map((v) => fn(String(v))),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finishReason = { unified: 'stop' as const, raw: 'stop' };

const EXHAUSTED = 'mockChatModel: no scripted stream/generate response left';

/**
 * Each streamText call consumes the next `stream` entry; each generateText call the next `generate` entry.
 * An Error entry makes that call throw (to exercise error paths). Once a queue is exhausted, further
 * calls throw too, so an unexpected extra LLM call fails the test instead of silently yielding ''.
 */
export function mockChatModel(opts: {
  stream?: (string[] | Error)[];
  generate?: (string | Error)[];
}) {
  const streams = [...(opts.stream ?? [])];
  const gens = [...(opts.generate ?? [])];
  return new MockLanguageModelV4({
    modelId: 'mock-chat',
    doStream: async () => {
      const deltas = streams.shift();
      if (deltas === undefined) throw new Error(EXHAUSTED);
      if (deltas instanceof Error) throw deltas;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
            { type: 'text-end' as const, id: 't1' },
            { type: 'finish' as const, finishReason, usage },
          ],
        }),
      };
    },
    doGenerate: async () => {
      const text = gens.shift();
      if (text === undefined) throw new Error(EXHAUSTED);
      if (text instanceof Error) throw text;
      return { content: [{ type: 'text' as const, text }], finishReason, usage, warnings: [] };
    },
  });
}

export function fakeReranker(score: (query: string, doc: string) => number): Reranker {
  return {
    async rerank(query, documents, topN) {
      return documents
        .map((d, index) => ({ index, score: score(query, d) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    },
  };
}

export function failingReranker(): Reranker {
  return {
    async rerank() {
      throw new RerankError('rerank unavailable (test)');
    },
  };
}
