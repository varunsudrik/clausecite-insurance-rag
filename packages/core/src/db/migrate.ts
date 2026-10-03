import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * True when this file is the process entry point. `import.meta.url` is the real path while argv[1]
 * is the path as typed, so a symlinked entry (pnpm links node_modules/@clausecite/core in the Docker
 * image) must be resolved first: otherwise the CLI below is skipped and the process exits 0 having
 * migrated nothing.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// CLI: `node dist/db/migrate.js`
if (isEntryPoint()) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url, 1);
  await runMigrations(db);
  await pool.end();
  console.log('migrations applied');
}
