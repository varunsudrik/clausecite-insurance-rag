import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asc,
  documents,
  eq,
  inArray,
  publishIngestJob,
  type DbHandle,
  type DocumentRow,
  type RabbitConnection,
} from '@clausecite/core';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { API_ENV, DATABASE, RABBIT, type ApiConfig } from '../infra/tokens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicDocument = Omit<DocumentRow, 'filePath' | 'sha256'>;

export function toPublicDocument(row: DocumentRow): PublicDocument {
  const { filePath: _filePath, sha256: _sha256, ...rest } = row;
  return rest;
}

export interface UploadMeta {
  slug: string;
  title: string;
  insurer: string;
  product: string;
  policy_type: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(RABBIT) private readonly rabbit: RabbitConnection,
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

  async resolveMany(idsOrSlugs: string[]): Promise<string[]> {
    if (idsOrSlugs.length === 0) return [];
    const uuids = idsOrSlugs.filter((x) => UUID_RE.test(x));
    const slugs = idsOrSlugs.filter((x) => !UUID_RE.test(x));
    const rows = [
      ...(uuids.length
        ? await this.database.db
            .select({ id: documents.id })
            .from(documents)
            .where(inArray(documents.id, uuids))
        : []),
      ...(slugs.length
        ? await this.database.db
            .select({ id: documents.id })
            .from(documents)
            .where(inArray(documents.slug, slugs))
        : []),
    ];
    if (rows.length !== new Set(idsOrSlugs).size) {
      throw new NotFoundException('one or more documents not found');
    }
    return rows.map((r) => r.id);
  }

  filePath(row: DocumentRow): string {
    return join(this.env.STORAGE_DIR, row.filePath);
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

    const [slugTaken] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.slug, meta.slug))
      .limit(1);
    if (slugTaken) {
      throw new ConflictException(`slug "${meta.slug}" is already used by another document`);
    }

    await mkdir(this.env.STORAGE_DIR, { recursive: true });
    const fileName = `${sha256}.pdf`;
    await writeFile(join(this.env.STORAGE_DIR, fileName), file);

    const [doc] = await db
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
    await publishIngestJob(this.rabbit.channel, doc.id);
    return { doc, deduplicated: false };
  }

  async reingest(idOrSlug: string): Promise<DocumentRow> {
    const doc = await this.resolve(idOrSlug);
    const [updated] = await this.database.db
      .update(documents)
      .set({ status: 'queued', attempts: 0, error: null })
      .where(eq(documents.id, doc.id))
      .returning();
    await publishIngestJob(this.rabbit.channel, doc.id);
    return updated;
  }
}
