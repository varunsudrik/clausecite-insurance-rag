import { describe, expect, it } from 'vitest';
import { makeHighlighter } from './highlight';

describe('makeHighlighter', () => {
  const h = makeHighlighter(
    'C.3 Specified Disease Waiting Period\nThe following procedures are covered only after 24 months',
  );
  it('marks text items that occur in the passage (case/whitespace-insensitive)', () => {
    expect(h('covered only after 24   MONTHS')).toBe('<mark>covered only after 24   MONTHS</mark>');
  });
  it('escapes HTML and leaves unrelated items unmarked', () => {
    expect(h('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(h('Ambulance cover')).toBe('Ambulance cover');
  });
  it('ignores tiny fragments to avoid noise', () => {
    expect(h('the')).toBe('the');
  });
});
