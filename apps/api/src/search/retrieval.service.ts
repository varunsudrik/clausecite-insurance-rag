import {
  createCachedQueryEmbedder,
  retrieve,
  searchChunks,
  type DbHandle,
  type Models,
  type Reranker,
  type RetrievalStrategy,
  type RetrieveResult,
} from '@clausecite/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  API_ENV,
  CACHE_REDIS,
  DATABASE,
  MODELS,
  RERANKER,
  type ApiConfig,
} from '../infra/tokens.js';

export interface RunOptions {
  query: string;
  documentIds?: string[];
  strategy?: RetrievalStrategy;
  topK?: number;
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger('Retrieval');

  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(MODELS) private readonly models: Models,
    @Inject(RERANKER) private readonly reranker: Reranker,
    @Inject(CACHE_REDIS) private readonly cache: Redis,
    @Inject(API_ENV) private readonly env: ApiConfig,
  ) {}

  async run(opts: RunOptions): Promise<RetrieveResult & { embeddingCacheHit: boolean }> {
    let embeddingCacheHit = false;
    const embedQuery = createCachedQueryEmbedder(
      this.models.embedding,
      this.models.ids.embedding,
      { get: (k) => this.cache.get(k), set: (k, v, ttl) => this.cache.set(k, v, 'EX', ttl) },
      { onHit: () => (embeddingCacheHit = true) },
    );
    const result = await retrieve(
      {
        search: (p) => searchChunks(this.database.db, p),
        embedQuery,
        reranker: this.reranker,
        onRerankDegraded: (err) => this.logger.warn(`rerank_degraded: ${(err as Error).message}`),
      },
      {
        query: opts.query,
        documentIds: opts.documentIds,
        strategy: opts.strategy,
        topK: opts.topK ?? this.env.RETRIEVAL_TOP_K,
        candidates: this.env.RETRIEVAL_CANDIDATES,
        threshold: this.env.RERANK_THRESHOLD,
      },
    );
    return { ...result, embeddingCacheHit };
  }
}
