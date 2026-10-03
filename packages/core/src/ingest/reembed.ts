import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { documents } from '../db/schema.js';

export interface ReembedOptions {
  db: Db;
  /** The model documents should be embedded with (EMBEDDING_MODEL). */
  embeddingModel: string;
  /** Publishes one ingest job; a rejection means the job was not accepted. */
  publish: (documentId: string) => Promise<void>;
  /** Only list the stale documents: change no row and publish nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Re-enqueues every `ready` document embedded with a different model (or none) than `embeddingModel`
 * (spec §3.5): resets it to `queued` and publishes an ingest job. Returns how many documents it found
 * (and, unless `dryRun`, enqueued).
 *
 * A document is set to `queued` before its job is published, so a worker that picks the job up at once
 * cannot have its `processing`/`ready` update overwritten. If the publish is rejected, that document is
 * put back to `ready`: otherwise it would be stranded as `queued` with no job, and a re-run (which only
 * selects `ready` documents) would never find it. The error is then rethrown; documents handled before
 * the failure stay enqueued and the rest are untouched.
 */
export async function reembedStale(opts: ReembedOptions): Promise<number> {
  const { db, embeddingModel, publish, dryRun = false, log = () => undefined } = opts;
  const stale = await db
    .select({ id: documents.id, slug: documents.slug, embeddingModel: documents.embeddingModel })
    .from(documents)
    .where(
      and(
        eq(documents.status, 'ready'),
        sql`${documents.embeddingModel} IS DISTINCT FROM ${embeddingModel}`,
      ),
    )
    .orderBy(asc(documents.slug));

  for (const d of stale) log(`${d.slug}: ${d.embeddingModel ?? '(none)'} → ${embeddingModel}`);
  if (dryRun) return stale.length;

  for (const d of stale) {
    await db
      .update(documents)
      .set({ status: 'queued', attempts: 0, error: null })
      .where(eq(documents.id, d.id));
    try {
      await publish(d.id);
    } catch (err) {
      log(`failed to enqueue ${d.slug}: ${reason(err)}`);
      // Guarded on 'queued' so a job that was in fact delivered and already picked up is not clobbered.
      await db
        .update(documents)
        .set({ status: 'ready' })
        .where(and(eq(documents.id, d.id), eq(documents.status, 'queued')))
        .catch((revertErr) =>
          log(`could not revert ${d.slug} to ready (reset it by hand): ${reason(revertErr)}`),
        );
      throw err;
    }
  }
  return stale.length;
}
