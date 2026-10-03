import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { documents, eq, INGEST_QUEUE } from '@clausecite/core';
import { NotFoundException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const variant = (tag: string) => Buffer.concat([PDF, Buffer.from(`\n%${tag}`)]);
let h: Harness;
let admin: string;
let guest: string;

beforeAll(async () => {
  h = await startHarness();
  admin = (
    await h.http.post('/auth/login').send({ email: 'admin@test.local', password: 'admin-pass-123' })
  ).body.token;
  guest = (await h.http.post('/auth/guest')).body.token;
});
afterAll(async () => {
  await h?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const upload = (
  token: string,
  file: Buffer,
  slug = 'sample-health',
  contentType = 'application/pdf',
) =>
  h.http
    .post('/documents')
    .set('Authorization', `Bearer ${token}`)
    .field('slug', slug)
    .field('title', 'Sample Health Shield')
    .field('insurer', 'Acme')
    .field('product', 'Sample Health Shield')
    .attach('file', file, { filename: 'policy.pdf', contentType });

const nextJob = async () => {
  const msg = await h.rabbit.channel.get(INGEST_QUEUE, { noAck: true });
  return msg ? JSON.parse(msg.content.toString()) : null;
};

const storedFiles = async () => (await readdir(h.storageDir)).sort();

/** Makes every confirm-channel publish fail the way a broker nack / closed channel would. */
const failPublishes = () =>
  vi.spyOn(h.rabbit.channel, 'publish').mockImplementation(((
    _exchange: string,
    _routingKey: string,
    _content: Buffer,
    _options: unknown,
    callback?: (err: Error | null) => void,
  ) => {
    callback?.(new Error('broker nack'));
    return true;
  }) as never);

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('documents', () => {
  let id: string;

  it('forbids guests from uploading', async () => {
    await upload(guest, PDF).expect(403);
  });

  it('stores the PDF, creates a queued document and enqueues an ingest job', async () => {
    const res = await upload(admin, PDF).expect(201);
    id = res.body.id;
    expect(res.body).toMatchObject({
      slug: 'sample-health',
      status: 'queued',
      deduplicated: false,
    });
    expect(res.body.filePath).toBeUndefined();
    expect(res.body.sha256).toBeUndefined();
    expect(await nextJob()).toEqual({ documentId: id, attempt: 0 });
    // content-addressed, and no temp files left behind by the atomic write
    expect(await storedFiles()).toEqual([`${PDF_SHA}.pdf`]);
    await access(join(h.storageDir, `${PDF_SHA}.pdf`));
  });

  it('deduplicates identical uploads without enqueueing again', async () => {
    const res = await upload(admin, PDF, 'another-slug').expect(200);
    expect(res.body).toMatchObject({ id, deduplicated: true });
    expect(await nextJob()).toBeNull();
  });

  it('rejects non-PDF bytes, a non-PDF MIME type and slug collisions without storing anything', async () => {
    const before = await storedFiles();
    await upload(admin, Buffer.from('hello, not a pdf'), 'not-pdf').expect(400);
    // a genuine PDF body is still refused when the part is not declared application/pdf
    const mime = await upload(admin, variant('mime'), 'wrong-mime', 'text/plain').expect(400);
    expect(mime.body.message).toBe('file must be application/pdf');
    await upload(admin, variant('different'), 'sample-health').expect(409);
    expect(await storedFiles()).toEqual(before);
    expect(await nextJob()).toBeNull();
  });

  it('validates the multipart request: missing file, bad metadata, oversize file', async () => {
    const before = await storedFiles();
    await h.http
      .post('/documents')
      .set(as(admin))
      .field('slug', 'no-file')
      .field('title', 'T')
      .field('insurer', 'I')
      .field('product', 'P')
      .expect(400);
    await upload(admin, PDF, 'Bad Slug!').expect(400);
    const oversize = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024)]);
    await upload(admin, oversize, 'too-large').expect(413);
    expect(await storedFiles()).toEqual(before);
  });

  it('lists, resolves by id or slug, and streams the file', async () => {
    const auth = as(guest);
    const list = await h.http.get('/documents').set(auth).expect(200);
    expect(list.body.map((d: { slug: string }) => d.slug)).toEqual(['sample-health']);
    await h.http.get(`/documents/${id}`).set(auth).expect(200);
    const bySlug = await h.http.get('/documents/sample-health').set(auth).expect(200);
    expect(bySlug.body.id).toBe(id);
    await h.http.get('/documents/nope-nope').set(auth).expect(404);
    const file = await h.http.get(`/documents/${id}/file`).set(auth).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('inline; filename="sample-health.pdf"');
    expect(file.headers['content-length']).toBe(String(PDF.length));
    expect(file.headers['cache-control']).toBe('private, max-age=3600');
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
  });

  it('re-enqueues on reingest (admin only)', async () => {
    await h.http.post(`/documents/${id}/reingest`).set(as(guest)).expect(403);
    await h.http.post(`/documents/${id}/reingest`).set(as(admin)).expect(202);
    expect(await nextJob()).toEqual({ documentId: id, attempt: 0 });
  });

  it('shows guests only the error code and admins the full error text', async () => {
    const full = 'PARSE_FAILED: cannot read /srv/data/storage/x.pdf (page 3)';
    await h.db.update(documents).set({ status: 'failed', error: full }).where(eq(documents.id, id));
    try {
      const guestDetail = await h.http.get(`/documents/${id}`).set(as(guest)).expect(200);
      expect(guestDetail.body).toMatchObject({ status: 'failed', error: 'PARSE_FAILED' });
      const guestList = await h.http.get('/documents').set(as(guest)).expect(200);
      expect(guestList.body[0].error).toBe('PARSE_FAILED');
      const adminDetail = await h.http.get(`/documents/${id}`).set(as(admin)).expect(200);
      expect(adminDetail.body.error).toBe(full);
      const adminList = await h.http.get('/documents').set(as(admin)).expect(200);
      expect(adminList.body[0].error).toBe(full);
      // free text without a code is never shown to guests
      await h.db
        .update(documents)
        .set({ error: 'something went wrong near /srv/data' })
        .where(eq(documents.id, id));
      const opaque = await h.http.get(`/documents/${id}`).set(as(guest)).expect(200);
      expect(opaque.body.error).toBe('ERROR');
    } finally {
      await h.db
        .update(documents)
        .set({ status: 'queued', error: null })
        .where(eq(documents.id, id));
    }
  });

  it('returns a clean 404 when the stored file has gone missing', async () => {
    const stored = join(h.storageDir, `${PDF_SHA}.pdf`);
    await rename(stored, `${stored}.moved`);
    try {
      const res = await h.http.get(`/documents/${id}/file`).set(as(guest)).expect(404);
      expect(res.body.message).toBe('document file not found');
      expect(res.text).not.toContain(h.storageDir);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.headers['content-type']).not.toContain('pdf');
      expect(res.headers['cache-control'] ?? '').not.toContain('max-age');
    } finally {
      await rename(`${stored}.moved`, stored);
    }
    await h.http.get(`/documents/${id}/file`).set(as(guest)).expect(200);
  });

  it('answers a generic 500 (no storage path) when the file stream fails before any byte is sent', async () => {
    const svc = h.app.get(DocumentsService);
    const broken = new Readable({
      read() {
        this.destroy(new Error(`EIO: i/o error, read '${h.storageDir}/${PDF_SHA}.pdf'`));
      },
    });
    vi.spyOn(svc, 'openFile').mockResolvedValue({ stream: broken as never, size: PDF.length });
    const res = await h.http.get(`/documents/${id}/file`).set(as(guest)).expect(500);
    expect(res.text).not.toContain(h.storageDir);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-length']).not.toBe(String(PDF.length));
    expect(res.headers['cache-control'] ?? '').not.toContain('max-age');
  });

  it('leaves no document behind when the ingest job cannot be enqueued, so a retry works', async () => {
    const bytes = variant('enqueue-fail');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const spy = failPublishes();
    const res = await upload(admin, bytes, 'enqueue-fail').expect(503);
    expect(res.body.message).toBe('could not enqueue ingestion, please retry');
    expect(spy).toHaveBeenCalled();
    const rows = await h.db.select().from(documents).where(eq(documents.slug, 'enqueue-fail'));
    expect(rows).toEqual([]);
    // the content-addressed file is kept
    expect(await storedFiles()).toContain(`${sha}.pdf`);
    expect(await nextJob()).toBeNull();

    vi.restoreAllMocks();
    const retry = await upload(admin, bytes, 'enqueue-fail').expect(201);
    expect(retry.body.deduplicated).toBe(false);
    expect(await nextJob()).toEqual({ documentId: retry.body.id, attempt: 0 });
  });

  it('marks the document failed with ENQUEUE_FAILED when a reingest cannot be enqueued', async () => {
    failPublishes();
    const res = await h.http.post(`/documents/${id}/reingest`).set(as(admin)).expect(503);
    expect(res.body.message).toBe('could not enqueue ingestion, please retry');
    const [row] = await h.db.select().from(documents).where(eq(documents.id, id));
    expect(row).toMatchObject({ status: 'failed', error: 'ENQUEUE_FAILED: broker nack' });
    const adminView = await h.http.get(`/documents/${id}`).set(as(admin)).expect(200);
    expect(adminView.body.error).toBe('ENQUEUE_FAILED: broker nack');
    const guestView = await h.http.get(`/documents/${id}`).set(as(guest)).expect(200);
    expect(guestView.body.error).toBe('ENQUEUE_FAILED');
    expect(await nextJob()).toBeNull();

    vi.restoreAllMocks();
    const ok = await h.http.post(`/documents/${id}/reingest`).set(as(admin)).expect(202);
    expect(ok.body).toMatchObject({ status: 'queued', error: null, attempts: 0 });
    expect(await nextJob()).toEqual({ documentId: id, attempt: 0 });
  });

  it('resolveMany accepts ids and slugs, dedupes, and requires every input to exist', async () => {
    const svc = h.app.get(DocumentsService);
    expect(await svc.resolveMany([])).toEqual([]);
    expect(await svc.resolveMany([id, 'sample-health'])).toEqual([id]);
    expect(await svc.resolveMany([id.toUpperCase(), id])).toEqual([id]);
    expect(await svc.resolveMany([id.toUpperCase()])).toEqual([id]);
    await expect(svc.resolveMany(['sample-health', 'nope-nope'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.resolveMany([id, 'nope-nope'])).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.resolveMany([id, '00000000-0000-4000-8000-000000000000']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('survives concurrent uploads: one winner, the rest dedupe or conflict, never a 500', async () => {
    const same = variant('race-same-bytes');
    const dupes = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => upload(admin, same, `race-same-${n}`)),
    );
    expect(dupes.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(dupes.map((r) => r.body.id)).size).toBe(1);
    const winner = dupes.find((r) => r.status === 201)!.body.id;
    expect(await nextJob()).toEqual({ documentId: winner, attempt: 0 });
    expect(await nextJob()).toBeNull();

    const clashes = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => upload(admin, variant(`race-slug-${n}`), 'race-same-slug')),
    );
    expect(clashes.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await nextJob()).not.toBeNull();
    expect(await nextJob()).toBeNull();

    expect((await storedFiles()).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
