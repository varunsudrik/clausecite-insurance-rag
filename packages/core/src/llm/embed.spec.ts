import { describe, expect, it } from 'vitest';
import { mockEmbeddingModel } from '../testing/mock-models.js';
import { embedQuery, embedTexts } from './embed.js';

describe('embedTexts', () => {
  it('embeds in batches and preserves input order', async () => {
    const model = mockEmbeddingModel((t) => [Number(t), 0]);
    const values = Array.from({ length: 250 }, (_, i) => String(i));
    const { embeddings } = await embedTexts(model, values, { batchSize: 100 });
    expect(embeddings).toHaveLength(250);
    expect(embeddings[0][0]).toBe(0);
    expect(embeddings[249][0]).toBe(249);
    expect(model.doEmbedCalls.length).toBe(3);
  });

  it('honours a custom batchSize (the model alone would allow 100 per call)', async () => {
    const model = mockEmbeddingModel((t) => [Number(t), 0]);
    const values = Array.from({ length: 250 }, (_, i) => String(i));
    const { embeddings } = await embedTexts(model, values, { batchSize: 50 });
    expect(model.doEmbedCalls.length).toBe(5);
    for (const call of model.doEmbedCalls) expect(call.values.length).toBeLessThanOrEqual(50);
    expect(embeddings.map((e) => e[0])).toEqual(values.map(Number));
  });

  it('defaults to batches of 100 even when the model accepts far more per call', async () => {
    const model = mockEmbeddingModel((t) => [Number(t), 0], { maxEmbeddingsPerCall: 1000 });
    const values = Array.from({ length: 250 }, (_, i) => String(i));
    await embedTexts(model, values);
    expect(model.doEmbedCalls.map((c) => c.values.length)).toEqual([100, 100, 50]);
  });

  it('sums token usage across batches', async () => {
    const model = mockEmbeddingModel((t) => [Number(t), 0]); // mock reports 1 token per value
    const values = Array.from({ length: 250 }, (_, i) => String(i));
    const { tokens } = await embedTexts(model, values, { batchSize: 100 });
    expect(tokens).toBe(250);
  });

  it('rejects a batchSize below 1 instead of looping forever', async () => {
    const model = mockEmbeddingModel();
    await expect(embedTexts(model, ['a'], { batchSize: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(embedTexts(model, ['a'], { batchSize: -5 })).rejects.toBeInstanceOf(RangeError);
    expect(model.doEmbedCalls.length).toBe(0);
  });

  it('returns an empty result for no input without calling the model', async () => {
    const model = mockEmbeddingModel();
    expect(await embedTexts(model, [])).toEqual({ embeddings: [], tokens: 0 });
    expect(model.doEmbedCalls.length).toBe(0);
  });

  it('embedQuery returns a single vector', async () => {
    const v = await embedQuery(mockEmbeddingModel(), 'room rent limit');
    expect(v).toHaveLength(1536);
  });

  describe('embedQuery timeout', () => {
    it('aborts a slow embedding call once timeoutMs elapses', async () => {
      const model = mockEmbeddingModel(undefined, { delayMs: 200 });
      const begin = Date.now();
      await expect(embedQuery(model, 'x', { timeoutMs: 20 })).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(Date.now() - begin).toBeLessThan(150);
    });

    it('does not abort when no timeout is given', async () => {
      const model = mockEmbeddingModel(undefined, { delayMs: 200 });
      expect(await embedQuery(model, 'x')).toHaveLength(1536);
    });

    it('does not abort a call that finishes within the timeout', async () => {
      const model = mockEmbeddingModel(undefined, { delayMs: 20 });
      expect(await embedQuery(model, 'x', { timeoutMs: 1_000 })).toHaveLength(1536);
    });
  });
});
