export type { ChatMeta, ClauseCiteUIMessage, SourceRef } from '@clausecite/core';

export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type PublicDocument = {
  id: string;
  slug: string;
  title: string;
  insurer: string;
  product: string;
  policyType: string;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number | null;
  embeddingModel: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};
