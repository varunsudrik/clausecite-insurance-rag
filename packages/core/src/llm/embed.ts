import { embed, embedMany, type EmbeddingModel } from 'ai';

export async function embedTexts(
  model: EmbeddingModel,
  values: string[],
  opts: { batchSize?: number; maxRetries?: number } = {},
): Promise<{ embeddings: number[][]; tokens: number }> {
  const batchSize = opts.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`embedTexts: batchSize must be an integer >= 1, got ${batchSize}`);
  }
  const embeddings: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < values.length; i += batchSize) {
    const res = await embedMany({
      model,
      values: values.slice(i, i + batchSize),
      maxRetries: opts.maxRetries ?? 3,
    });
    embeddings.push(...res.embeddings);
    tokens += res.usage?.tokens ?? 0;
  }
  return { embeddings, tokens };
}

/** `timeoutMs` aborts the embedding call (retries included) once it elapses; unset means no limit. */
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
