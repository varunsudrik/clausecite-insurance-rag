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

  describe('prompt construction', () => {
    const promptText = (model: ReturnType<typeof mockChatModel>) =>
      model.doGenerateCalls[0].prompt
        .filter((m) => m.role === 'user')
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('');

    it('includes only the last 6 history turns', async () => {
      const model = mockChatModel({ generate: ['Standalone?'] });
      const history = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `TURN-${i}`,
      }));
      await rewriteQuestion(model, history, 'and then?');
      const prompt = promptText(model);
      expect(prompt).not.toContain('TURN-0');
      expect(prompt).not.toContain('TURN-1');
      for (const i of [2, 3, 4, 5, 6, 7]) expect(prompt).toContain(`TURN-${i}`);
    });

    it('truncates each history turn to 1000 characters', async () => {
      const model = mockChatModel({ generate: ['Standalone?'] });
      await rewriteQuestion(model, [{ role: 'assistant', content: 'Z'.repeat(1500) }], 'and then?');
      const runs = promptText(model).match(/Z+/g) ?? [];
      expect(Math.max(...runs.map((r) => r.length))).toBe(1000);
    });

    it('caps the latest message at 2000 characters in the prompt', async () => {
      const model = mockChatModel({ generate: ['Standalone?'] });
      await rewriteQuestion(model, [{ role: 'user', content: 'x' }], 'Q'.repeat(3000));
      const runs = promptText(model).match(/Q+/g) ?? [];
      expect(Math.max(...runs.map((r) => r.length))).toBe(2000);
    });
  });

  describe('output cleanup', () => {
    const history = [{ role: 'user' as const, content: 'x' }];
    const rewrite = async (output: string) =>
      rewriteQuestion(mockChatModel({ generate: [output] }), history, 'and for my mother?');

    it.each([
      ['"Is cataract covered?"', 'Is cataract covered?'],
      ["'Is cataract covered?'", 'Is cataract covered?'],
      ['\u201cIs cataract covered?\u201d', 'Is cataract covered?'],
      ['  Is cataract covered?  \n', 'Is cataract covered?'],
    ])('strips a matching surrounding quote pair: %s', async (output, expected) => {
      expect(await rewrite(output)).toMatchObject({ question: expected, rewritten: true });
    });

    it.each([
      ['"Is cataract covered?', '"Is cataract covered?'],
      ['Is cataract covered?"', 'Is cataract covered?"'],
      ['"Is cataract covered?\'', '"Is cataract covered?\''],
      ['What is the "waiting period"?', 'What is the "waiting period"?'],
      ["What is Star's limit?", "What is Star's limit?"],
    ])('preserves unbalanced or interior quotes: %s', async (output, expected) => {
      expect(await rewrite(output)).toMatchObject({ question: expected, rewritten: true });
    });

    it('strips a leading "Standalone question:" label', async () => {
      expect(await rewrite('Standalone question: Is cataract covered?')).toMatchObject({
        question: 'Is cataract covered?',
        rewritten: true,
      });
      expect(await rewrite('standalone question:\n"Is cataract covered?"')).toMatchObject({
        question: 'Is cataract covered?',
        rewritten: true,
      });
    });

    it('caps the rewritten question at 500 characters', async () => {
      const r = await rewrite('w'.repeat(900));
      expect(r.question).toHaveLength(500);
    });

    it('falls back to the original but keeps the token counts when the model returns nothing', async () => {
      const r = await rewrite('   ');
      expect(r).toEqual({
        question: 'and for my mother?',
        rewritten: false,
        inputTokens: 10,
        outputTokens: 5,
      });
    });

    it('treats a label-only or quotes-only output as empty', async () => {
      expect(await rewrite('Standalone question:')).toMatchObject({
        question: 'and for my mother?',
        rewritten: false,
      });
      expect(await rewrite('""')).toMatchObject({
        question: 'and for my mother?',
        rewritten: false,
      });
    });
  });
});
