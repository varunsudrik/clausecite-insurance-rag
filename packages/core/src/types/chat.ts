import type { UIMessage } from 'ai';
import type { Citation, MessageLatency, MessageUsage } from '../db/schema.js';
import type { RankedChunk } from '../retrieval/retrieve.js';

export interface SourceRef {
  n: number;
  chunkId: string;
  documentId: string;
  slug: string;
  documentTitle: string;
  insurer: string;
  clauseId: string;
  clauseIds: string[];
  sectionPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
  rerankScore: number | null;
}

export interface ChatMeta {
  messageId: string;
  conversationId: string;
  status: 'complete' | 'refused' | 'error';
  citations: Citation[];
  uncited: boolean;
  usage: MessageUsage | null;
  latencyMs: MessageLatency;
  rerankDegraded: boolean;
}

export type ClauseCiteDataParts = {
  sources: { conversationId: string; question: string; sources: SourceRef[] };
  meta: ChatMeta;
};

export type ClauseCiteUIMessage = UIMessage<unknown, ClauseCiteDataParts>;

export function toSourceRefs(chunks: RankedChunk[]): SourceRef[] {
  return chunks.map((c, i) => ({
    n: i + 1,
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
    rerankScore: c.rerankScore,
  }));
}
