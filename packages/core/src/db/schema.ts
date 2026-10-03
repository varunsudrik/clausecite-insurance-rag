import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIMENSIONS = 1536;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const DOCUMENT_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    insurer: text('insurer').notNull(),
    product: text('product').notNull(),
    policyType: text('policy_type').notNull(),
    filePath: text('file_path').notNull(),
    sha256: text('sha256').notNull().unique(),
    status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('queued'),
    error: text('error'),
    pageCount: integer('page_count'),
    chunkCount: integer('chunk_count'),
    embeddingModel: text('embedding_model'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('documents_status_check', sql`${t.status} in ('queued','processing','ready','failed')`),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    clauseId: text('clause_id').notNull(),
    clauseIds: text('clause_ids').array().notNull(),
    sectionPath: text('section_path').array().notNull(),
    pageStart: integer('page_start').notNull(),
    pageEnd: integer('page_end').notNull(),
    content: text('content').notNull(),
    contentForEmbedding: text('content_for_embedding').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', content_for_embedding)`),
    createdAt: createdAt(),
  },
  (t) => [
    index('chunks_embedding_hnsw')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    index('chunks_tsv_gin').using('gin', t.tsv),
    index('chunks_document_id_idx').on(t.documentId),
    index('chunks_document_clause_idx').on(t.documentId, t.clauseId),
  ],
);

export const USER_ROLES = ['guest', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').unique(),
    passwordHash: text('password_hash'),
    role: text('role', { enum: USER_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [check('users_role_check', sql`${t.role} in ('guest','admin')`)],
);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  documentIds: uuid('document_ids').array(),
  createdAt: createdAt(),
});

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  clauseId: string;
  pageStart: number;
  pageEnd: number;
}

export interface MessageUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface MessageLatency {
  rewrite?: number;
  embed?: number;
  retrieve?: number;
  rerank?: number;
  firstToken?: number;
  total?: number;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    mode: text('mode', { enum: ['quick', 'deep'] }),
    status: text('status', { enum: ['complete', 'error', 'refused'] })
      .notNull()
      .default('complete'),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    usage: jsonb('usage').$type<MessageUsage | null>(),
    latencyMs: jsonb('latency_ms').$type<MessageLatency | null>(),
    retrievedChunkIds: uuid('retrieved_chunk_ids').array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    check('messages_role_check', sql`${t.role} in ('user','assistant')`),
    check('messages_status_check', sql`${t.status} in ('complete','error','refused')`),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
