// Usage: pnpm reembed [--dry-run]
// Re-enqueues every ready document embedded with a different model than EMBEDDING_MODEL (spec §3.5).
// A document whose job cannot be published is put back to ready and the script exits non-zero.
import {
  connectRabbit,
  createDb,
  dbEnv,
  llmEnv,
  loadEnv,
  publishIngestJob,
  rabbitEnv,
  reembedStale,
  type RabbitConnection,
} from '@clausecite/core';

const dryRun = process.argv.includes('--dry-run');
const { DATABASE_URL } = loadEnv(dbEnv);
// Only the model name is needed here (no OPENROUTER_API_KEY): nothing is embedded by this script.
const { EMBEDDING_MODEL } = loadEnv(llmEnv.pick({ EMBEDDING_MODEL: true }));
const { db, pool } = createDb(DATABASE_URL, 2);

// Opened on the first publish, so a dry run or an up-to-date database never touches the broker.
let conn = undefined as RabbitConnection | undefined;
try {
  const count = await reembedStale({
    db,
    embeddingModel: EMBEDDING_MODEL,
    dryRun,
    log: console.log,
    publish: async (documentId) => {
      if (!conn) {
        const rabbit = loadEnv(rabbitEnv);
        conn = await connectRabbit(rabbit.RABBITMQ_URL, {
          retryDelaysMs: rabbit.INGEST_RETRY_DELAYS_MS,
        });
      }
      await publishIngestJob(conn.channel, documentId);
    },
  });
  console.log(
    `${dryRun ? 'would re-enqueue' : 're-enqueued'} ${count} documents (model → ${EMBEDDING_MODEL})`,
  );
} finally {
  await conn?.close();
  await pool.end();
}
