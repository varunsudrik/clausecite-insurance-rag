import { describe, expect, it } from 'vitest';
import { sanitizeHistory } from './history.js';

const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

describe('sanitizeHistory', () => {
  it('returns an empty history unchanged', () => {
    expect(sanitizeHistory([])).toEqual([]);
  });

  it('leaves a clean alternating history alone', () => {
    const turns = [user('q1'), assistant('a1'), user('q2'), assistant('a2')];
    expect(sanitizeHistory(turns)).toEqual(turns);
  });

  it('does not mutate its input', () => {
    const turns = [user('q'), assistant('Covered [1].')];
    sanitizeHistory(turns);
    expect(turns[1].content).toBe('Covered [1].');
  });

  describe('citation markers', () => {
    it('strips markers and the single space before them from assistant turns', () => {
      expect(
        sanitizeHistory([user('q'), assistant('Covered after 24 months [1]. Not otherwise.')]),
      ).toEqual([user('q'), assistant('Covered after 24 months. Not otherwise.')]);
    });

    it('strips adjacent and comma-grouped markers', () => {
      expect(
        sanitizeHistory([user('q'), assistant('Both apply [1][3] and also [2, 4], [5,6].')]),
      ).toEqual([user('q'), assistant('Both apply and also,.')]);
    });

    it('strips a marker that has no space before it', () => {
      expect(sanitizeHistory([user('q'), assistant('Covered[1]. Yes.')])).toEqual([
        user('q'),
        assistant('Covered. Yes.'),
      ]);
    });

    it('removes only one preceding space', () => {
      expect(sanitizeHistory([user('q'), assistant('Covered  [1].')])).toEqual([
        user('q'),
        assistant('Covered .'),
      ]);
    });

    it('leaves brackets that are not citation markers', () => {
      const text = 'Clause [C.3] and [a] and [] and [1-3] stay.';
      expect(sanitizeHistory([user('q'), assistant(text)])[1]).toEqual(assistant(text));
    });

    it('never rewrites user turns', () => {
      expect(sanitizeHistory([user('what does [1] mean?'), assistant('It means x [1].')])).toEqual([
        user('what does [1] mean?'),
        assistant('It means x.'),
      ]);
    });
  });

  describe('empty turns', () => {
    it('drops turns that are empty or whitespace-only', () => {
      expect(sanitizeHistory([user('q1'), assistant('a1'), user('  \n'), assistant('a2')])).toEqual(
        [user('q1'), assistant('a1\n\na2')],
      );
    });

    it('drops an assistant turn that was nothing but markers', () => {
      expect(
        sanitizeHistory([user('q1'), assistant('[1][2]'), user('q2'), assistant('a2')]),
      ).toEqual([user('q1\n\nq2'), assistant('a2')]);
    });

    it('returns an empty history when every turn is empty', () => {
      expect(sanitizeHistory([user(' '), assistant('[1]')])).toEqual([]);
    });
  });

  describe('leading assistant turns', () => {
    it('drops assistant turns before the first user turn', () => {
      expect(
        sanitizeHistory([assistant('orphan'), assistant('orphan 2'), user('q'), assistant('a')]),
      ).toEqual([user('q'), assistant('a')]);
    });

    it('drops a history that is only assistant turns', () => {
      expect(sanitizeHistory([assistant('a1'), assistant('a2')])).toEqual([]);
    });

    it('drops a leading assistant turn exposed by dropping an empty user turn', () => {
      expect(sanitizeHistory([user(''), assistant('a1'), user('q2'), assistant('a2')])).toEqual([
        user('q2'),
        assistant('a2'),
      ]);
    });
  });

  describe('consecutive turns', () => {
    it('merges consecutive user turns with a blank line', () => {
      expect(sanitizeHistory([user('q1'), user('q2'), assistant('a')])).toEqual([
        user('q1\n\nq2'),
        assistant('a'),
      ]);
    });

    it('merges consecutive assistant turns with a blank line', () => {
      expect(sanitizeHistory([user('q'), assistant('a1 [1]'), assistant('a2 [2]')])).toEqual([
        user('q'),
        assistant('a1\n\na2'),
      ]);
    });

    it('merges runs of more than two turns', () => {
      expect(sanitizeHistory([user('a'), user('b'), user('c')])).toEqual([user('a\n\nb\n\nc')]);
    });

    it('merges turns that become adjacent after an errored exchange is filtered out', () => {
      // q1 -> (errored answer removed) -> q2 -> a2
      expect(sanitizeHistory([user('q1'), user('q2'), assistant('a2 [1]')])).toEqual([
        user('q1\n\nq2'),
        assistant('a2'),
      ]);
    });
  });
});
