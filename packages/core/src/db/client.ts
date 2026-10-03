import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function createDb(url: string, max = 10): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    // pgvector >= 0.8: keep scanning the HNSW graph when WHERE filters remove candidates.
    // Sent as a connection startup parameter, so it is in effect before the first query and
    // needs no extra round trip (a fire-and-forget SET in a 'connect' hook would race with it).
    options: '-c hnsw.iterative_scan=relaxed_order',
  });
  // An idle client can error (e.g. Postgres restarts); without a listener that would be an
  // unhandled 'error' event and crash the process.
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  const db = drizzle(pool, { schema });
  return { db, pool };
}
