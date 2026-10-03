import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { createDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  url: string;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  let pool: pg.Pool | undefined;
  try {
    const url = container.getConnectionUri();
    const handle = createDb(url, 5);
    pool = handle.pool;
    await runMigrations(handle.db);
    return {
      db: handle.db,
      pool: handle.pool,
      url,
      async stop() {
        await handle.pool.end();
        await container.stop();
      },
    };
  } catch (err) {
    // Don't leak the container (or its pool) when setup fails after the container started.
    await pool?.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw err;
  }
}
