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
  const url = container.getConnectionUri();
  const { db, pool } = createDb(url, 5);
  await runMigrations(db);
  return {
    db,
    pool,
    url,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
