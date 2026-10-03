import { describe, expect, it } from 'vitest';
import { sanitizePdfText } from './text-sanitize.js';

describe('sanitizePdfText', () => {
  it('removes a NUL inside a word and counts it', () => {
    expect(sanitizePdfText('O\u0000ce of the Insurance Ombudsman')).toEqual({
      text: 'Oce of the Insurance Ombudsman',
      removed: 1,
    });
  });

  it('removes the C0 controls (except tab and newline) and DEL', () => {
    const dirty = 'a\u0001b\u0007c\u000bd\u000ce\u000ef\u001fg\u007fh';
    expect(sanitizePdfText(dirty)).toEqual({ text: 'abcdefgh', removed: 7 });
  });

  it('keeps tabs and newlines', () => {
    expect(sanitizePdfText('a\tb\nc')).toEqual({ text: 'a\tb\nc', removed: 0 });
  });

  it('normalizes with NFKC: a ligature code point becomes plain letters, without counting as removed', () => {
    expect(sanitizePdfText('Oﬃce ﬁrst year')).toEqual({
      text: 'Office first year',
      removed: 0,
    });
  });

  it('removes lone surrogates but keeps valid surrogate pairs', () => {
    expect(sanitizePdfText('a\ud800b\udc00c')).toEqual({ text: 'abc', removed: 2 });
    expect(sanitizePdfText('trailing\ud83d')).toEqual({ text: 'trailing', removed: 1 });
    expect(sanitizePdfText('ok \u{1F600} ok')).toEqual({ text: 'ok \u{1F600} ok', removed: 0 });
  });

  it('returns clean text untouched', () => {
    expect(sanitizePdfText('Room rent, boarding ₹5,000 – 10 %')).toEqual({
      text: 'Room rent, boarding ₹5,000 – 10 %',
      removed: 0,
    });
    expect(sanitizePdfText('')).toEqual({ text: '', removed: 0 });
  });
});
