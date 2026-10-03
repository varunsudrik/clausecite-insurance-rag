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

  it('returns an empty result for no input without calling the model', async () => {
    const model = mockEmbeddingModel();
    expect(await embedTexts(model, [])).toEqual({ embeddings: [], tokens: 0 });
    expect(model.doEmbedCalls.length).toBe(0);
  });

  it('embedQuery returns a single vector', async () => {
    const v = await embedQuery(mockEmbeddingModel(), 'room rent limit');
    expect(v).toHaveLength(1536);
  });
});
