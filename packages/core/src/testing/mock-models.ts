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

export function mockEmbeddingModel(fn: (text: string) => number[] = (t) => hashEmbedding(t)) {
  return new MockEmbeddingModelV4({
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => fn(String(v))),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finishReason = { unified: 'stop' as const, raw: 'stop' };

/**
 * Each streamText call consumes the next `stream` entry; each generateText call the next `generate` entry.
 * An Error entry makes that call throw (to exercise error paths).
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
      const deltas = streams.shift() ?? [''];
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
      const text = gens.shift() ?? '';
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
