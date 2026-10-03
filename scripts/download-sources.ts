// Usage: pnpm sources:download
// Downloads every policy in data/sources.json to data/pdfs/sources/<slug>.pdf (git-ignored) and
// records sha256 + size in data/sources.lock.json (committed). Re-running skips files that are
// already on disk with the locked hash. A failing source is reported and skipped; exit code 1 if any failed.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  isPdf,
  mergeLock,
  parseLock,
  parseSources,
  sha256Hex,
  type LockEntry,
  type Source,
} from './lib/sources.ts';

const SOURCES_PATH = fileURLToPath(new URL('../data/sources.json', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../data/sources.lock.json', import.meta.url));
const PDF_DIR = fileURLToPath(new URL('../data/pdfs/sources/', import.meta.url));

const MAX_BYTES = 20 * 1024 * 1024; // the API's upload limit
const TIMEOUT_MS = 60_000;
// icicilombard.com and careinsurance.com answer 403 without a browser-like User-Agent and Accept-Language.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-IN,en;q=0.9',
  Accept: 'application/pdf,*/*;q=0.8',
};

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Reads the body, aborting as soon as it grows past MAX_BYTES instead of buffering all of it. */
async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error(`body too large (content-length ${declared} bytes)`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      await res.body.cancel();
      throw new Error(`body over ${MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return `timeout after ${TIMEOUT_MS / 1000}s`;
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${err.message} (${cause.code ?? cause.message})` : err.message;
}

async function download(source: Source): Promise<Buffer> {
  const res = await fetch(source.url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const bytes = await readCapped(res);
  // Some insurer sites answer 200 with an HTML page for a wrong path: trust the bytes, not the status.
  if (!isPdf(bytes)) {
    const type = res.headers.get('content-type') ?? 'unknown content-type';
    throw new Error(`not a PDF (no %PDF- header, ${type}, ${bytes.length} bytes)`);
  }
  return bytes;
}

const sources = parseSources(await readJson(SOURCES_PATH));
const rawLock = await readJson(LOCK_PATH);
let lock: LockEntry[] = rawLock === undefined ? [] : parseLock(rawLock);

await mkdir(PDF_DIR, { recursive: true });

const rows: { slug: string; result: string }[] = [];
let failed = 0;

for (const source of sources) {
  const file = `${PDF_DIR}${source.slug}.pdf`;
  const locked = lock.find((e) => e.slug === source.slug);
  try {
    if (locked && locked.url === source.url) {
      const onDisk = await readFile(file).catch(() => undefined);
      if (onDisk && sha256Hex(onDisk) === locked.sha256) {
        rows.push({
          slug: source.slug,
          result: `cached  ${onDisk.length} bytes  sha256 ${locked.sha256.slice(0, 12)}`,
        });
        continue;
      }
    }
    const bytes = await download(source);
    const tmp = `${file}.part`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    const entry: LockEntry = {
      slug: source.slug,
      url: source.url,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      retrievedAt: new Date().toISOString(),
    };
    lock = mergeLock(lock, entry);
    await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    rows.push({
      slug: source.slug,
      result: `ok      ${entry.bytes} bytes  sha256 ${entry.sha256.slice(0, 12)}`,
    });
  } catch (err) {
    failed++;
    rows.push({ slug: source.slug, result: `FAILED  ${describeError(err)}  <${source.url}>` });
  }
}

// Drop lock entries for slugs that left the manifest, so the lock always describes data/sources.json.
const slugs = new Set(sources.map((s) => s.slug));
lock = lock.filter((e) => slugs.has(e.slug));
await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);

const width = Math.max(...rows.map((r) => r.slug.length));
for (const { slug, result } of rows) console.log(`${slug.padEnd(width)}  ${result}`);
console.log(
  `\n${sources.length - failed}/${sources.length} downloaded or cached, ${failed} failed`,
);
if (failed > 0) process.exitCode = 1;
