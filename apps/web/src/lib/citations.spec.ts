import { describe, expect, it } from 'vitest';
import { linkifyCitations } from './citations';

describe('linkifyCitations', () => {
  const valid = new Set([1, 2]);
  it('links valid markers only', () => {
    expect(linkifyCitations('Covered after 24 months [1][2]. Not [7].', valid)).toBe(
      'Covered after 24 months [1](#cite-1)[2](#cite-2). Not [7].',
    );
  });
  it('leaves inline and fenced code untouched', () => {
    expect(linkifyCitations('see `arr[1]` and\n```\nx[2]\n```\nok [2]', valid)).toBe(
      'see `arr[1]` and\n```\nx[2]\n```\nok [2](#cite-2)',
    );
  });
  it('does not double-link existing markdown links', () => {
    expect(linkifyCitations('[1](#cite-1)', valid)).toBe('[1](#cite-1)');
  });
});
