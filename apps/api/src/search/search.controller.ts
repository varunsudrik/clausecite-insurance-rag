import type { RankedChunk } from '@clausecite/core';
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService } from '../documents/documents.service.js';
import { RateLimit } from '../limits/policies.js';
import { RateLimitGuard } from '../limits/rate-limit.guard.js';
import { RetrievalService } from './retrieval.service.js';

const searchBody = z.object({
  query: z.string().trim().min(1).max(500),
  documentIds: z.array(z.string().min(1)).max(20).optional(),
  strategy: z.enum(['vector', 'fts', 'hybrid', 'hybrid_rerank']).default('hybrid_rerank'),
  k: z.number().int().min(1).max(20).optional(),
});

export const toResult = (c: RankedChunk) => ({
  chunkId: c.chunkId,
  documentId: c.documentId,
  slug: c.slug,
  documentTitle: c.documentTitle,
  insurer: c.insurer,
  clauseId: c.clauseId,
  clauseIds: c.clauseIds,
  sectionPath: c.sectionPath,
  pageStart: c.pageStart,
  pageEnd: c.pageEnd,
  content: c.content,
  score: c.score,
  rerankScore: c.rerankScore,
});

@Controller('search')
export class SearchController {
  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(DocumentsService) private readonly docs: DocumentsService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit('search')
  async search(@Body(new ZodPipe(searchBody)) body: z.infer<typeof searchBody>) {
    const documentIds = body.documentIds
      ? await this.docs.resolveMany(body.documentIds)
      : undefined;
    const r = await this.retrieval.run({
      query: body.query,
      documentIds,
      strategy: body.strategy,
      topK: body.k,
    });
    return {
      strategy: body.strategy,
      refused: r.refused,
      rerankDegraded: r.rerankDegraded,
      embeddingCacheHit: r.embeddingCacheHit,
      results: r.chunks.map(toResult),
      suggestions: r.suggestions.map(toResult),
      timings: r.timings,
    };
  }
}
