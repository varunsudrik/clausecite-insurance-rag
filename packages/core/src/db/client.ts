import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function createDb(url: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  // pgvector >= 0.8: keep scanning the HNSW graph when WHERE filters remove candidates.
  pool.on('connect', (client) => {
    client.query('SET hnsw.iterative_scan = relaxed_order').catch(() => undefined);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
