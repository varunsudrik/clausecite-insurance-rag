import { describe, expect, it } from 'vitest';
import {
  isPdf,
  lockSchema,
  mergeLock,
  parseSources,
  sha256Hex,
  type LockEntry,
  type Source,
} from './sources.ts';

const source = (over: Record<string, unknown> = {}) => ({
  slug: 'hdfc-ergo-optima-secure',
  insurer: 'HDFC ERGO',
  product: 'my: Optima Secure',
  title: 'HDFC ERGO my: Optima Secure',
  policy_type: 'health',
  uin: 'HDFHLIP26058V082526',
  url: 'https://example.com/policy.pdf',
  ...over,
});

const lock = (slug: string, over: Partial<LockEntry> = {}): LockEntry => ({
  slug,
  url: `https://example.com/${slug}.pdf`,
  sha256: 'a'.repeat(64),
  bytes: 10,
  retrievedAt: '2026-10-03T00:00:00.000Z',
  ...over,
});

describe('parseSources', () => {
  it('accepts a valid manifest, with or without a uin', () => {
    const { uin: _uin, ...noUin } = source({ slug: 'no-uin-policy' });
    const parsed: Source[] = parseSources([source(), noUin]);
    expect(parsed.map((s) => s.slug)).toEqual(['hdfc-ergo-optima-secure', 'no-uin-policy']);
  });

  it('rejects duplicate slugs', () => {
    expect(() => parseSources([source(), source({ title: 'Other' })])).toThrow(/duplicate slug/i);
  });

  it('rejects a non-https URL', () => {
    expect(() => parseSources([source({ url: 'http://example.com/p.pdf' })])).toThrow();
    expect(() => parseSources([source({ url: 'ftp://example.com/p.pdf' })])).toThrow();
    expect(() => parseSources([source({ url: 'not a url' })])).toThrow();
  });

  it('rejects a bad slug', () => {
    for (const slug of ['Upper-Case', 'ab', 'has space', 'under_score', 'x'.repeat(81)]) {
      expect(() => parseSources([source({ slug })])).toThrow();
    }
  });

  it('rejects a policy_type other than health', () => {
    expect(() => parseSources([source({ policy_type: 'motor' })])).toThrow();
  });

  it('rejects a non-array manifest', () => {
    expect(() => parseSources({ slug: 'x' })).toThrow();
  });
});

describe('isPdf', () => {
  it('is true only for buffers starting with %PDF-', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(isPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
    expect(isPdf(Buffer.from('<!DOCTYPE html><html>'))).toBe(false);
    expect(isPdf(Buffer.from(' %PDF-1.7'))).toBe(false);
    expect(isPdf(Buffer.from('%PDF'))).toBe(false);
    expect(isPdf(Buffer.alloc(0))).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('returns the known digest', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('mergeLock', () => {
  it('adds a new entry and keeps the result sorted by slug', () => {
    const merged = mergeLock([lock('b-policy'), lock('d-policy')], lock('c-policy'));
    expect(merged.map((e) => e.slug)).toEqual(['b-policy', 'c-policy', 'd-policy']);
  });

  it('replaces an entry by slug without touching the others', () => {
    const existing = [lock('a-policy'), lock('b-policy')];
    const merged = mergeLock(existing, lock('a-policy', { bytes: 99, sha256: 'b'.repeat(64) }));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ slug: 'a-policy', bytes: 99, sha256: 'b'.repeat(64) });
    expect(merged[1]).toEqual(existing[1]);
    expect(existing[0]?.bytes).toBe(10); // input not mutated
  });
});

describe('lockSchema', () => {
  it('accepts a well-formed lock and rejects a bad sha256', () => {
    expect(lockSchema.parse([lock('a-policy')])).toHaveLength(1);
    expect(() => lockSchema.parse([lock('a-policy', { sha256: 'xyz' })])).toThrow();
    expect(() => lockSchema.parse([lock('a-policy', { retrievedAt: 'yesterday' })])).toThrow();
  });
});
