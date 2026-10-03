// Usage: pnpm reembed [--dry-run]
// Re-enqueues every ready document embedded with a different model than EMBEDDING_MODEL (spec §3.5).
import {
  and,
  connectRabbit,
  createDb,
  dbEnv,
  documents,
  eq,
  llmEnv,
  loadEnv,
  publishIngestJob,
  rabbitEnv,
  sql,
} from '@clausecite/core';

const dryRun = process.argv.includes('--dry-run');
const { DATABASE_URL } = loadEnv(dbEnv);
const { EMBEDDING_MODEL } = loadEnv(llmEnv);
const { db, pool } = createDb(DATABASE_URL, 2);

try {
  const stale = await db
    .select({ id: documents.id, slug: documents.slug, embeddingModel: documents.embeddingModel })
    .from(documents)
    .where(
      and(
        eq(documents.status, 'ready'),
        sql`${documents.embeddingModel} IS DISTINCT FROM ${EMBEDDING_MODEL}`,
      ),
    );

  for (const d of stale)
    console.log(`${d.slug}: ${d.embeddingModel ?? '(none)'} → ${EMBEDDING_MODEL}`);

  if (!dryRun && stale.length > 0) {
    const rabbit = loadEnv(rabbitEnv);
    const conn = await connectRabbit(rabbit.RABBITMQ_URL, {
      retryDelaysMs: rabbit.INGEST_RETRY_DELAYS_MS,
    });
    try {
      for (const d of stale) {
        await db
          .update(documents)
          .set({ status: 'queued', attempts: 0, error: null })
          .where(eq(documents.id, d.id));
        await publishIngestJob(conn.channel, d.id);
      }
    } finally {
      await conn.close();
    }
  }
  console.log(
    `${dryRun ? 'would re-enqueue' : 're-enqueued'} ${stale.length} documents (model → ${EMBEDDING_MODEL})`,
  );
} finally {
  await pool.end();
}
