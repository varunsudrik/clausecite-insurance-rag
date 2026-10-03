import { z } from 'zod';

export interface RerankHit {
  index: number;
  score: number;
}

export interface Reranker {
  rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]>;
}

export class RerankError extends Error {
  override name = 'RerankError';
}

const MAX_ERROR_BODY_CHARS = 500;

const responseSchema = z.object({
  results: z.array(z.object({ index: z.number().int(), relevance_score: z.number() })),
});

export function createOpenRouterReranker(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Reranker {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseURL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  return {
    async rerank(query, documents, topN) {
      if (documents.length === 0) return [];
      let res: Response;
      try {
        res = await doFetch(`${base}/rerank`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.model, query, documents, top_n: topN }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
        });
      } catch (err) {
        throw new RerankError(`rerank request failed: ${(err as Error)?.message ?? err}`, {
          cause: err,
        });
      }
      if (!res.ok) {
        // The body read can itself fail (timeout/abort/network) - never leak a raw error.
        const body = await res.text().catch(() => '');
        throw new RerankError(`rerank HTTP ${res.status}: ${body.slice(0, MAX_ERROR_BODY_CHARS)}`);
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success)
        throw new RerankError(`unexpected rerank response: ${parsed.error.message}`);
      const seen = new Set<number>();
      for (const { index } of parsed.data.results) {
        if (index < 0 || index >= documents.length || seen.has(index)) {
          throw new RerankError(
            `rerank returned an invalid or duplicate index ${index} for ${documents.length} documents`,
          );
        }
        seen.add(index);
      }
      return parsed.data.results
        .map((r) => ({ index: r.index, score: r.relevance_score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    },
  };
}
