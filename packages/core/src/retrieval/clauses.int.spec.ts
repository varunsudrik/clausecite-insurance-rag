import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunks, documents } from '../db/schema.js';
import { hashEmbedding } from '../testing/mock-models.js';
import { startTestDb, type TestDb } from '../testing/postgres.js';
import { findDefinitions, getClauseChunks } from './clauses.js';

let t: TestDb;
let docA: string;
let docB: string;

async function seedDoc(
  slug: string,
  rows: { clauseId: string; clauseIds?: string[]; path: string[]; text: string }[],
) {
  const [doc] = await t.db
    .insert(documents)
    .values({
      slug,
      title: slug,
      insurer: 'Acme',
      product: slug,
      policyType: 'health',
      filePath: `${slug}.pdf`,
      sha256: randomUUID(),
      status: 'ready',
    })
    .returning();
  await t.db.insert(chunks).values(
    rows.map((r, i) => ({
      documentId: doc.id,
      chunkIndex: i,
      clauseId: r.clauseId,
      clauseIds: r.clauseIds ?? [r.clauseId],
      sectionPath: r.path,
      pageStart: i + 1,
      pageEnd: i + 1,
      content: r.text,
      contentForEmbedding: r.text,
      tokenCount: 10,
      embedding: hashEmbedding(r.text),
    })),
  );
  return doc.id;
}

beforeAll(async () => {
  t = await startTestDb();
  docA = await seedDoc('a', [
    { clauseId: 'C.3', path: ['Section C'], text: 'Cataract part one.' },
    { clauseId: 'C.4', clauseIds: ['C.4', 'C.3'], path: ['Section C'], text: 'Cataract part two.' },
    { clauseId: 'C.3', path: ['Section C'], text: 'Cataract part three.' },
    { clauseId: 'D.1', path: ['Section D'], text: 'Hospital means an institution.' },
    {
      clauseId: 'DEF.1',
      path: ['Section A', 'Definitions'],
      text: 'Hospital means an institution.',
    },
    { clauseId: 'DEF.2', path: ['Section A', 'Definitions'], text: 'Grace period means 30 days.' },
    { clauseId: 'DEF.3', path: ['Section A', 'Definitions'], text: 'Coverage is 100% of cost_x.' },
    {
      clauseId: 'DEF.4',
      path: ['Section A', 'DEFINITIONS AND TERMS'],
      text: 'HOSPITAL also covers day-care.',
    },
  ]);
  docB = await seedDoc('b', [
    { clauseId: 'C.3', path: ['Section C'], text: 'Other document cataract.' },
    { clauseId: 'DEF.1', path: ['Definitions'], text: 'Hospital means something else.' },
  ]);
});
afterAll(async () => {
  await t?.stop();
});

describe('getClauseChunks', () => {
  it('matches clause_id or membership in clause_ids, in chunk order, scoped to the document', async () => {
    const res = await getClauseChunks(t.db, docA, 'C.3');
    expect(res.map((r) => r.chunkIndex)).toEqual([0, 1, 2]);
    expect(res.map((r) => r.content)).toEqual([
      'Cataract part one.',
      'Cataract part two.',
      'Cataract part three.',
    ]);
    expect(res[1]).toMatchObject({ clauseId: 'C.4', clauseIds: ['C.4', 'C.3'], pageStart: 2 });
    expect(await getClauseChunks(t.db, docB, 'C.3')).toHaveLength(1);
  });

  it('returns nothing for an unknown clause', async () => {
    expect(await getClauseChunks(t.db, docA, 'Z.9')).toEqual([]);
  });
});

describe('findDefinitions', () => {
  it('only searches chunks under a definitions section, case-insensitively, in chunk order', async () => {
    const res = await findDefinitions(t.db, docA, 'hospital');
    expect(res.map((r) => r.clauseId)).toEqual(['DEF.1', 'DEF.4']);
    expect(res.every((r) => r.sectionPath.some((s) => /definition/i.test(s)))).toBe(true);
  });

  it('is scoped to the document and respects the limit', async () => {
    expect((await findDefinitions(t.db, docB, 'hospital')).map((r) => r.content)).toEqual([
      'Hospital means something else.',
    ]);
    expect(await findDefinitions(t.db, docA, 'hospital', 1)).toHaveLength(1);
  });

  it('treats LIKE wildcards in the term literally', async () => {
    expect(await findDefinitions(t.db, docA, '%%')).toEqual([]);
    expect(await findDefinitions(t.db, docA, '__')).toEqual([]);
    expect((await findDefinitions(t.db, docA, '100%')).map((r) => r.clauseId)).toEqual(['DEF.3']);
    expect((await findDefinitions(t.db, docA, 'cost_x')).map((r) => r.clauseId)).toEqual(['DEF.3']);
    expect(await findDefinitions(t.db, docA, 'cost\\x')).toEqual([]);
  });
});
