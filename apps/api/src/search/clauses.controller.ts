import { findDefinitions, getClauseChunks, type DbHandle } from '@clausecite/core';
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DATABASE } from '../infra/tokens.js';

const definitionsQuery = z.object({
  term: z.string().trim().min(2).max(100),
  documentId: z.string().min(1),
});

@Controller()
export class ClausesController {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(DocumentsService) private readonly docs: DocumentsService,
  ) {}

  @Get('documents/:id/clauses/:clauseId')
  async clause(@Param('id') id: string, @Param('clauseId') clauseId: string) {
    const doc = await this.docs.resolve(id);
    const parts = await getClauseChunks(this.database.db, doc.id, clauseId);
    if (parts.length === 0) {
      throw new NotFoundException(`clause ${clauseId} not found in ${doc.slug}`);
    }
    return {
      documentId: doc.id,
      slug: doc.slug,
      clauseId,
      sectionPath: parts[0].sectionPath,
      pageStart: Math.min(...parts.map((p) => p.pageStart)),
      pageEnd: Math.max(...parts.map((p) => p.pageEnd)),
      chunks: parts,
    };
  }

  @Get('definitions')
  async definitions(@Query(new ZodPipe(definitionsQuery)) q: z.infer<typeof definitionsQuery>) {
    const doc = await this.docs.resolve(q.documentId);
    return {
      documentId: doc.id,
      slug: doc.slug,
      term: q.term,
      results: await findDefinitions(this.database.db, doc.id, q.term),
    };
  }
}
