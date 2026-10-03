import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { hashEmbedding, mockChatModel } from './mock-models.js';

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('test doubles', () => {
  it('hashEmbedding is deterministic, unit-length, and similar for overlapping words', () => {
    const a = hashEmbedding('cataract waiting period');
    expect(hashEmbedding('cataract waiting period')).toEqual(a);
    expect(Math.abs(cos(a, a) - 1)).toBeLessThan(1e-9);
    expect(cos(a, hashEmbedding('waiting period for cataract'))).toBeGreaterThan(
      cos(a, hashEmbedding('ambulance cover limit')),
    );
  });

  it('mockChatModel streams then generates in call order', async () => {
    const model = mockChatModel({ stream: [['Hello ', 'world [1]']], generate: ['rewritten'] });
    const s = streamText({ model, prompt: 'x' });
    expect(await s.text).toBe('Hello world [1]');
    const g = await generateText({ model, prompt: 'y' });
    expect(g.text).toBe('rewritten');
  });
});
