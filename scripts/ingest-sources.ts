// Usage: pnpm sources:ingest [--reingest-failed]
// Uploads every PDF listed in data/sources.lock.json (see `pnpm sources:download`) through the API
// as the admin, then polls GET /documents until each reaches ready or failed. The worker must be
// running (it consumes the ingest jobs). Env: ADMIN_EMAIL, ADMIN_PASSWORD, API_URL (default http://localhost:3001;
// plain http is refused for any host except localhost, 127.0.0.1 and [::1], because the credentials go over it).
// With --reingest-failed, documents the API already holds in the `failed` state (for example after a parser fix) are
// queued again via POST /documents/:id/reingest. Exit code 1 if any document failed to upload or ingest. Never prints the password or the token.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { apiUrlProblem } from './lib/api-url.ts';
import { parseLock, parseSources, sha256Hex, type Source } from './lib/sources.ts';

const SOURCES_PATH = fileURLToPath(new URL('../data/sources.json', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../data/sources.lock.json', import.meta.url));
const PDF_DIR = fileURLToPath(new URL('../data/pdfs/sources/', import.meta.url));

const POLL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const urlProblem = apiUrlProblem(API_URL);
if (urlProblem) {
  console.error(urlProblem);
  process.exit(2);
}
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error(
    'ADMIN_EMAIL and ADMIN_PASSWORD must be set (the repo .env is loaded automatically).',
  );
  process.exit(2);
}

interface ApiDocument {
  id: string;
  slug: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  pageCount: number | null;
  chunkCount: number | null;
  error: string | null;
}

interface Row {
  slug: string;
  status: string;
  pages: number | null;
  chunks: number | null;
  error: string;
}

/** The `message` of a Nest error body, shortened; the raw body is never echoed. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    const msg = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch {
    // not JSON
  }
  return res.statusText;
}

const signal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

async function login(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: signal(),
  });
  if (res.status !== 200) {
    throw new Error(`admin login failed: HTTP ${res.status} ${await errorMessage(res)}`);
  }
  const { token } = (await res.json()) as { token?: unknown };
  if (typeof token !== 'string' || !token) throw new Error('admin login returned no token');
  return token;
}

const sources = new Map<string, Source>(
  parseSources(JSON.parse(await readFile(SOURCES_PATH, 'utf8'))).map((s) => [s.slug, s]),
);
const lock = parseLock(JSON.parse(await readFile(LOCK_PATH, 'utf8')));
if (lock.length === 0) {
  console.error('data/sources.lock.json is empty: run `pnpm sources:download` first.');
  process.exit(2);
}

const token = await login();
const auth = { Authorization: `Bearer ${token}` };
console.log(`logged in to ${API_URL}; uploading ${lock.length} documents`);

const rows: Row[] = [];
const reingestFailed = process.argv.includes('--reingest-failed');
const tracked: { id: string; slug: string; status: ApiDocument['status'] }[] = []; // uploaded documents, by API id

for (const entry of lock) {
  const source = sources.get(entry.slug);
  const fail = (error: string) => {
    rows.push({ slug: entry.slug, status: 'not-uploaded', pages: null, chunks: null, error });
  };
  if (!source) {
    fail('slug is in the lockfile but not in data/sources.json');
    continue;
  }
  const bytes = await readFile(`${PDF_DIR}${entry.slug}.pdf`).catch(() => undefined);
  if (!bytes) {
    fail('PDF missing on disk: run `pnpm sources:download`');
    continue;
  }
  if (sha256Hex(bytes) !== entry.sha256) {
    fail('PDF on disk does not match the lockfile sha256: run `pnpm sources:download`');
    continue;
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), `${entry.slug}.pdf`);
  form.append('slug', source.slug);
  form.append('title', source.title);
  form.append('insurer', source.insurer);
  form.append('product', source.product);
  form.append('policy_type', source.policy_type);

  try {
    const res = await fetch(`${API_URL}/documents`, {
      method: 'POST',
      headers: auth,
      body: form,
      signal: signal(),
    });
    if (res.status === 201 || res.status === 200) {
      const doc = (await res.json()) as ApiDocument & { deduplicated?: boolean };
      const note =
        res.status === 200 && doc.slug !== entry.slug
          ? `already ingested as "${doc.slug}"`
          : res.status === 200
            ? 'deduplicated'
            : undefined;
      tracked.push({ id: doc.id, slug: entry.slug, status: doc.status });
      console.log(`${entry.slug}: ${res.status === 201 ? 'uploaded' : (note ?? 'deduplicated')}`);
    } else if (res.status === 409) {
      fail(`409 slug already taken by different bytes (${await errorMessage(res)})`);
    } else {
      fail(`HTTP ${res.status} ${await errorMessage(res)}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function listDocuments(): Promise<ApiDocument[]> {
  const res = await fetch(`${API_URL}/documents`, { headers: auth, signal: signal() });
  if (res.status !== 200) throw new Error(`GET /documents failed: HTTP ${res.status}`);
  return (await res.json()) as ApiDocument[];
}

if (reingestFailed) {
  for (const doc of tracked.filter((d) => d.status === 'failed')) {
    const res = await fetch(`${API_URL}/documents/${doc.id}/reingest`, {
      method: 'POST',
      headers: auth,
      signal: signal(),
    });
    const outcome =
      res.status === 202 ? 'queued again' : `HTTP ${res.status} ${await errorMessage(res)}`;
    console.log(`${doc.slug}: reingest ${outcome}`);
  }
}

const deadline = Date.now() + POLL_TIMEOUT_MS;
let latest = new Map<string, ApiDocument>();
let lastFinished = -1;
while (tracked.length > 0) {
  try {
    latest = new Map((await listDocuments()).map((d) => [d.id, d]));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err)); // transient: keep polling
  }
  const pending = tracked.filter(({ id }) => {
    const status = latest.get(id)?.status;
    return status !== 'ready' && status !== 'failed';
  });
  const finished = tracked.length - pending.length;
  if (finished !== lastFinished) console.log(`${finished}/${tracked.length} finished`);
  lastFinished = finished;
  if (pending.length === 0) break;
  if (Date.now() + POLL_MS > deadline) break;
  await sleep(POLL_MS);
}

for (const { id, slug } of tracked) {
  const doc = latest.get(id);
  const finished = doc?.status === 'ready' || doc?.status === 'failed';
  rows.push({
    slug,
    status: doc?.status ?? 'unknown',
    pages: doc?.pageCount ?? null,
    chunks: doc?.chunkCount ?? null,
    error: doc?.error ?? (finished ? '' : 'timed out waiting'),
  });
}
rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

const cell = (v: string | number | null) => (v === null ? '-' : String(v));
const header = ['slug', 'status', 'pages', 'chunks', 'error'];
const table = rows.map((r) => [
  r.slug,
  r.status,
  cell(r.pages),
  cell(r.chunks),
  r.error.slice(0, 150),
]);
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
const line = (cols: string[]) =>
  cols
    .map((c, i) => c.padEnd(widths[i]!))
    .join('  ')
    .trimEnd();
console.log(`\n${line(header)}\n${line(widths.map((w) => '-'.repeat(w)))}`);
for (const row of table) console.log(line(row));

const bad = rows.filter((r) => r.status !== 'ready');
const sum = (key: 'pages' | 'chunks') => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
console.log(
  `\n${rows.length - bad.length}/${rows.length} ready, ${bad.length} not ready; ${sum('pages')} pages, ${sum('chunks')} chunks`,
);
if (bad.length > 0) process.exitCode = 1;
