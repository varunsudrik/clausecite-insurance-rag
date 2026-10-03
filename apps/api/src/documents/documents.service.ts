import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asc,
  documents,
  eq,
  inArray,
  type DbHandle,
  type DocumentRow,
  type UserRole,
} from '@clausecite/core';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RabbitPublisher } from '../infra/rabbit-publisher.js';
import { API_ENV, DATABASE, RABBIT, type ApiConfig } from '../infra/tokens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';
const ENQUEUE_FAILED_MESSAGE = 'could not enqueue ingestion, please retry';

export type PublicDocument = Omit<DocumentRow, 'filePath' | 'sha256'>;

/**
 * The machine-readable part of a stored error ("CODE: details"). Guests must never see the details
 * (they can contain paths and library messages); free text without a code collapses to "ERROR".
 */
export function errorCode(error: string): string {
  const colon = error.indexOf(':');
  if (colon !== -1) return error.slice(0, colon).trim() || 'ERROR';
  return /^[A-Z0-9_]{1,64}$/.test(error) ? error : 'ERROR';
}

/**
 * Drops `filePath` and `sha256`. Only admins get the full `error` text; every other caller
 * (guests, or an unknown role) gets the error code only.
 */
export function toPublicDocument(row: DocumentRow, role?: UserRole): PublicDocument {
  const { filePath: _filePath, sha256: _sha256, ...rest } = row;
  if (role === 'admin' || rest.error === null) return rest;
  return { ...rest, error: errorCode(rest.error) };
}

/** node-postgres reports `code`; drizzle 0.45 wraps it in a DrizzleQueryError whose `cause` is that error. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface UploadMeta {
  slug: string;
  title: string;
  insurer: string;
  product: string;
  policy_type: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(RABBIT) private readonly rabbit: RabbitPublisher,
    @Inject(API_ENV) private readonly env: ApiConfig,
  ) {}

  list(): Promise<DocumentRow[]> {
    return this.database.db.select().from(documents).orderBy(asc(documents.title));
  }

  async resolve(idOrSlug: string): Promise<DocumentRow> {
    const column = UUID_RE.test(idOrSlug) ? documents.id : documents.slug;
    const [row] = await this.database.db
      .select()
      .from(documents)
      .where(eq(column, idOrSlug))
      .limit(1);
    if (!row) throw new NotFoundException(`document ${idOrSlug} not found`);
    return row;
  }

  /** Turns ids and/or slugs into distinct document ids. Every input must exist. */
  async resolveMany(idsOrSlugs: string[]): Promise<string[]> {
    const inputs = new Set(idsOrSlugs.map((x) => (UUID_RE.test(x) ? x.toLowerCase() : x)));
    if (inputs.size === 0) return [];
    const uuids = [...inputs].filter((x) => UUID_RE.test(x));
    const slugs = [...inputs].filter((x) => !UUID_RE.test(x));
    const db = this.database.db;
    const [byId, bySlug] = await Promise.all([
      uuids.length
        ? db
            .select({ id: documents.id, slug: documents.slug })
            .from(documents)
            .where(inArray(documents.id, uuids))
        : [],
      slugs.length
        ? db
            .select({ id: documents.id, slug: documents.slug })
            .from(documents)
            .where(inArray(documents.slug, slugs))
        : [],
    ]);
    const foundIds = new Set(byId.map((r) => r.id));
    const foundSlugs = new Set(bySlug.map((r) => r.slug));
    if (!uuids.every((u) => foundIds.has(u)) || !slugs.every((s) => foundSlugs.has(s))) {
      throw new NotFoundException('one or more documents not found');
    }
    return [...new Set([...byId, ...bySlug].map((r) => r.id))];
  }

  filePath(row: DocumentRow): string {
    return join(this.env.STORAGE_DIR, row.filePath);
  }

  /**
   * Opens the stored PDF for streaming. The file is stat'ed first so a missing file becomes a clean
   * 404 before any response header is written (and without the storage path in the message).
   */
  async openFile(row: DocumentRow): Promise<{ stream: ReadStream; size: number }> {
    const path = this.filePath(row);
    const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!info?.isFile()) {
      this.logger.error(`stored file for document ${row.id} is missing: ${path}`);
      throw new NotFoundException('document file not found');
    }
    return { stream: createReadStream(path), size: info.size };
  }

  async upload(
    file: Buffer,
    meta: UploadMeta,
  ): Promise<{ doc: DocumentRow; deduplicated: boolean }> {
    if (file.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('file is not a PDF');
    }
    const sha256 = createHash('sha256').update(file).digest('hex');
    const db = this.database.db;

    const [existing] = await db
      .select()
      .from(documents)
      .where(eq(documents.sha256, sha256))
      .limit(1);
    if (existing) return { doc: existing, deduplicated: true };

    const slugConflict = () =>
      new ConflictException(`slug "${meta.slug}" is already used by another document`);
    const [slugTaken] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.slug, meta.slug))
      .limit(1);
    if (slugTaken) throw slugConflict();

    const fileName = `${sha256}.pdf`;
    await this.storeFile(fileName, file);

    let doc: DocumentRow;
    try {
      [doc] = await db
        .insert(documents)
        .values({
          slug: meta.slug,
          title: meta.title,
          insurer: meta.insurer,
          product: meta.product,
          policyType: meta.policy_type,
          filePath: fileName,
          sha256,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent upload: identical bytes dedupe, a taken slug conflicts.
      const [sameBytes] = await db
        .select()
        .from(documents)
        .where(eq(documents.sha256, sha256))
        .limit(1);
      if (sameBytes) return { doc: sameBytes, deduplicated: true };
      const [sameSlug] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.slug, meta.slug))
        .limit(1);
      if (sameSlug) throw slugConflict();
      throw err;
    }

    try {
      await this.rabbit.publishIngestJob(doc.id);
    } catch (err) {
      // Never leave a 'queued' row nobody will process: a retried upload would dedupe onto it.
      // The content-addressed file is kept; the retry reuses it.
      this.logger.error(`could not enqueue ingest job for ${doc.id}: ${messageOf(err)}`);
      await db
        .delete(documents)
        .where(eq(documents.id, doc.id))
        .catch(async (deleteErr: unknown) => {
          this.logger.error(`could not roll back document ${doc.id}: ${messageOf(deleteErr)}`);
          await this.markEnqueueFailed(doc.id, err);
        });
      throw new ServiceUnavailableException(ENQUEUE_FAILED_MESSAGE);
    }
    return { doc, deduplicated: false };
  }

  async reingest(idOrSlug: string): Promise<DocumentRow> {
    const doc = await this.resolve(idOrSlug);
    const [updated] = await this.database.db
      .update(documents)
      .set({ status: 'queued', attempts: 0, error: null })
      .where(eq(documents.id, doc.id))
      .returning();
    try {
      await this.rabbit.publishIngestJob(doc.id);
    } catch (err) {
      this.logger.error(`could not enqueue re-ingest job for ${doc.id}: ${messageOf(err)}`);
      await this.markEnqueueFailed(doc.id, err);
      throw new ServiceUnavailableException(ENQUEUE_FAILED_MESSAGE);
    }
    return updated;
  }

  private async markEnqueueFailed(id: string, cause: unknown): Promise<void> {
    await this.database.db
      .update(documents)
      .set({ status: 'failed', error: `ENQUEUE_FAILED: ${messageOf(cause)}`.slice(0, 500) })
      .where(eq(documents.id, id))
      .catch((err: unknown) =>
        this.logger.error(`could not mark document ${id} as failed: ${messageOf(err)}`),
      );
  }

  /**
   * Writes `<sha256>.pdf` atomically (temp file + rename) so a worker reading an existing copy never
   * sees a truncated file. Content-addressed, so an existing file is already correct.
   */
  private async storeFile(fileName: string, bytes: Buffer): Promise<void> {
    const dir = this.env.STORAGE_DIR;
    const finalPath = join(dir, fileName);
    await mkdir(dir, { recursive: true });
    if (
      await access(finalPath).then(
        () => true,
        () => false,
      )
    )
      return;
    const tmpPath = `${finalPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, finalPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}
