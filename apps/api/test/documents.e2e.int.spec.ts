import { readFileSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { INGEST_QUEUE } from '@clausecite/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const PDF = readFileSync(new URL('../../../data/fixtures/sample-policy.pdf', import.meta.url));
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

const upload = (token: string, file: Buffer, slug = 'sample-health') =>
  h.http
    .post('/documents')
    .set('Authorization', `Bearer ${token}`)
    .field('slug', slug)
    .field('title', 'Sample Health Shield')
    .field('insurer', 'Acme')
    .field('product', 'Sample Health Shield')
    .attach('file', file, { filename: 'policy.pdf', contentType: 'application/pdf' });

const nextJob = async () => {
  const msg = await h.rabbit.channel.get(INGEST_QUEUE, { noAck: true });
  return msg ? JSON.parse(msg.content.toString()) : null;
};

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
    expect(await nextJob()).toEqual({ documentId: id, attempt: 0 });
    const files = await readdir(h.storageDir);
    expect(files).toHaveLength(1);
    await access(join(h.storageDir, files[0]));
  });

  it('deduplicates identical uploads without enqueueing again', async () => {
    const res = await upload(admin, PDF, 'another-slug').expect(200);
    expect(res.body).toMatchObject({ id, deduplicated: true });
    expect(await nextJob()).toBeNull();
  });

  it('rejects non-PDF bytes and slug collisions', async () => {
    await upload(admin, Buffer.from('hello, not a pdf'), 'not-pdf').expect(400);
    await upload(admin, Buffer.concat([PDF, Buffer.from('\n%different')]), 'sample-health').expect(
      409,
    );
  });

  it('validates the multipart request: missing file, bad metadata, oversize file', async () => {
    const auth = { Authorization: `Bearer ${admin}` };
    await h.http
      .post('/documents')
      .set(auth)
      .field('slug', 'no-file')
      .field('title', 'T')
      .field('insurer', 'I')
      .field('product', 'P')
      .expect(400);
    await upload(admin, PDF, 'Bad Slug!').expect(400);
    const oversize = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024)]);
    await upload(admin, oversize, 'too-large').expect(413);
  });

  it('lists, resolves by id or slug, and streams the file', async () => {
    const auth = { Authorization: `Bearer ${guest}` };
    const list = await h.http.get('/documents').set(auth).expect(200);
    expect(list.body.map((d: { slug: string }) => d.slug)).toEqual(['sample-health']);
    await h.http.get(`/documents/${id}`).set(auth).expect(200);
    const bySlug = await h.http.get('/documents/sample-health').set(auth).expect(200);
    expect(bySlug.body.id).toBe(id);
    await h.http.get('/documents/nope-nope').set(auth).expect(404);
    const file = await h.http.get(`/documents/${id}/file`).set(auth).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
  });

  it('re-enqueues on reingest (admin only)', async () => {
    await h.http
      .post(`/documents/${id}/reingest`)
      .set('Authorization', `Bearer ${guest}`)
      .expect(403);
    await h.http
      .post(`/documents/${id}/reingest`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(202);
    expect(await nextJob()).toEqual({ documentId: id, attempt: 0 });
  });
});
