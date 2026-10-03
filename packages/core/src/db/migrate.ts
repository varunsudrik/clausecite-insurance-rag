import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

// CLI: `node dist/db/migrate.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url, 1);
  await runMigrations(db);
  await pool.end();
  console.log('migrations applied');
}
