import { describe, expect, it } from 'vitest';
import { mockChatModel } from '../testing/mock-models.js';
import { rewriteQuestion } from './rewrite.js';

describe('rewriteQuestion', () => {
  it('returns the message unchanged without history (no model call)', async () => {
    const model = mockChatModel({});
    const r = await rewriteQuestion(model, [], 'Is cataract covered?');
    expect(r).toMatchObject({ question: 'Is cataract covered?', rewritten: false });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('rewrites follow-ups into standalone questions', async () => {
    const model = mockChatModel({
      generate: ['"What is the knee replacement waiting period in Star Comprehensive?"'],
    });
    const r = await rewriteQuestion(
      model,
      [
        { role: 'user', content: 'Star Comprehensive cataract waiting period?' },
        { role: 'assistant', content: '24 months [1].' },
      ],
      'and knee replacement?',
    );
    expect(r).toMatchObject({
      question: 'What is the knee replacement waiting period in Star Comprehensive?',
      rewritten: true,
    });
    expect(r.inputTokens).toBeGreaterThan(0);
  });

  it('falls back to the original message when the model fails', async () => {
    const model = mockChatModel({ generate: [new Error('timeout')] });
    const r = await rewriteQuestion(model, [{ role: 'user', content: 'x' }], 'and for my mother?');
    expect(r).toMatchObject({ question: 'and for my mother?', rewritten: false });
  });
});
