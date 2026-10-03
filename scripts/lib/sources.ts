// Pure helpers shared by `download-sources.ts` and `ingest-sources.ts`: the manifest and lockfile
// schemas, the %PDF- check, hashing and the lockfile merge. No I/O, so they are unit-testable.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const sourceSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/, 'slug must match /^[a-z0-9-]{3,80}$/'),
  insurer: z.string().min(1),
  product: z.string().min(1),
  title: z.string().min(1),
  policy_type: z.literal('health'),
  uin: z.string().min(1).optional(),
  url: z.url().refine((u) => new URL(u).protocol === 'https:', 'url must be https'),
});

export const sourcesSchema = z.array(sourceSchema).superRefine((sources, ctx) => {
  const seen = new Set<string>();
  sources.forEach((source, index) => {
    if (seen.has(source.slug)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'slug'],
        message: `duplicate slug "${source.slug}"`,
      });
    }
    seen.add(source.slug);
  });
});

export const lockEntrySchema = z.object({
  slug: z.string(),
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  retrievedAt: z.iso.datetime(),
});

export const lockSchema = z.array(lockEntrySchema);

export type Source = z.infer<typeof sourceSchema>;
export type LockEntry = z.infer<typeof lockEntrySchema>;

export const parseSources = (json: unknown): Source[] => sourcesSchema.parse(json);
export const parseLock = (json: unknown): LockEntry[] => lockSchema.parse(json);

const PDF_MAGIC = '%PDF-';

/** True only when the bytes start with `%PDF-` (a 200 HTML error page does not). */
export function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Returns a new lock with `entry` replacing any entry with the same slug, sorted by slug. */
export function mergeLock(existing: readonly LockEntry[], entry: LockEntry): LockEntry[] {
  return [...existing.filter((e) => e.slug !== entry.slug), entry].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
}
