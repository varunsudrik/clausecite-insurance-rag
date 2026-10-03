import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  buildRefusalText,
  buildUserPrompt,
  conversations,
  desc,
  eq,
  formatSources,
  messages,
  rewriteQuestion,
  SYSTEM_PROMPT,
  toSourceRefs,
  validateCitations,
  type ChatMeta,
  type ChatTurn,
  type ClauseCiteUIMessage,
  type DbHandle,
  type MessageLatency,
  type MessageUsage,
  type Models,
} from '@clausecite/core';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createUIMessageStream, streamText, type InferUIMessageChunk } from 'ai';
import type { AuthUser } from '../auth/auth.types.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DATABASE, MODELS } from '../infra/tokens.js';
import { LimitsService } from '../limits/limits.service.js';
import { RetrievalService } from '../search/retrieval.service.js';

export interface ChatBody {
  conversationId?: string;
  message: string;
  documentIds?: string[];
  mode: 'quick';
}

export interface PreparedChat {
  conversationId: string;
  documentIds: string[] | undefined;
  history: ChatTurn[];
  message: string;
}

type Chunk = InferUIMessageChunk<ClauseCiteUIMessage>;

@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(MODELS) private readonly models: Models,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(DocumentsService) private readonly docs: DocumentsService,
    @Inject(LimitsService) private readonly limits: LimitsService,
  ) {}

  /** Everything that can fail with a normal HTTP status happens here, before streaming starts. */
  async prepare(user: AuthUser, body: ChatBody): Promise<PreparedChat> {
    await this.limits.assertBudget(user);
    const db = this.database.db;
    let conversation: typeof conversations.$inferSelect | undefined;
    if (body.conversationId) {
      [conversation] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, user.id)))
        .limit(1);
      if (!conversation) throw new NotFoundException('conversation not found');
    }
    const requestedIds = body.documentIds
      ? await this.docs.resolveMany(body.documentIds)
      : undefined;
    if (!conversation) {
      [conversation] = await db
        .insert(conversations)
        .values({
          userId: user.id,
          title: body.message.slice(0, 80),
          documentIds: requestedIds ?? null,
        })
        .returning();
    }
    const previous = await db
      .select({ role: messages.role, content: messages.content, status: messages.status })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(6);
    const history = previous
      .reverse()
      .filter((m) => m.status !== 'error')
      .map((m) => ({ role: m.role, content: m.content }));
    await db
      .insert(messages)
      .values({ conversationId: conversation.id, role: 'user', content: body.message });
    return {
      conversationId: conversation.id,
      documentIds: requestedIds ?? conversation.documentIds ?? undefined,
      history,
      message: body.message,
    };
  }

  stream(user: AuthUser, chat: PreparedChat): ReadableStream<Chunk> {
    const messageId = randomUUID();
    const db = this.database.db;
    const t0 = performance.now();
    const latency: MessageLatency = {};
    let streamedText = '';
    let tokens = 0;

    const save = (values: Partial<typeof messages.$inferInsert>) =>
      db.insert(messages).values({
        id: messageId,
        conversationId: chat.conversationId,
        role: 'assistant',
        mode: 'quick',
        content: '',
        ...values,
      });

    return createUIMessageStream<ClauseCiteUIMessage>({
      onError: (err) => {
        this.logger.error(`chat failed: ${(err as Error)?.message ?? err}`);
        return 'Something went wrong while generating the answer. Please retry.';
      },
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageId });
        try {
          let t = performance.now();
          const rw = await rewriteQuestion(this.models.rewrite, chat.history, chat.message);
          latency.rewrite = Math.round(performance.now() - t);
          tokens += rw.inputTokens + rw.outputTokens;

          t = performance.now();
          const retrieval = await this.retrieval.run({
            query: rw.question,
            documentIds: chat.documentIds,
          });
          latency.embed = Math.round(retrieval.timings.embedMs);
          latency.retrieve = Math.round(retrieval.timings.searchMs);
          latency.rerank = Math.round(retrieval.timings.rerankMs);
          const sources = toSourceRefs(retrieval.chunks);
          writer.write({
            type: 'data-sources',
            data: { conversationId: chat.conversationId, question: rw.question, sources },
          });

          const meta = (over: Partial<ChatMeta>): ChatMeta => ({
            messageId,
            conversationId: chat.conversationId,
            status: 'complete',
            citations: [],
            uncited: false,
            usage: null,
            latencyMs: latency,
            rerankDegraded: retrieval.rerankDegraded,
            ...over,
          });

          if (retrieval.refused) {
            const text = buildRefusalText(retrieval.suggestions);
            writer.write({ type: 'text-start', id: 'answer' });
            writer.write({ type: 'text-delta', id: 'answer', delta: text });
            writer.write({ type: 'text-end', id: 'answer' });
            latency.total = Math.round(performance.now() - t0);
            await save({
              content: text,
              status: 'refused',
              latencyMs: latency,
              retrievedChunkIds: retrieval.suggestions.map((s) => s.chunkId),
            });
            await this.limits.recordUsage(user, tokens);
            writer.write({ type: 'data-meta', data: meta({ status: 'refused' }) });
            writer.write({ type: 'finish' });
            return;
          }

          t = performance.now();
          const result = streamText({
            model: this.models.chat,
            system: SYSTEM_PROMPT,
            messages: [
              ...chat.history.map((m) => ({ role: m.role, content: m.content })),
              {
                role: 'user' as const,
                content: buildUserPrompt(rw.question, formatSources(retrieval.chunks)),
              },
            ],
            temperature: 0.1,
            maxOutputTokens: 1200,
            maxRetries: 2,
            timeout: { totalMs: 60_000, firstChunkMs: 15_000 },
          });

          // The SDK masks provider errors as a generic text by default; keep the real cause for
          // the log (the client only ever sees the generic message from the outer onError).
          let streamError: unknown;
          for await (const chunk of result.toUIMessageStream<ClauseCiteUIMessage>({
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              streamError = error;
              return error instanceof Error ? error.message : 'generation failed';
            },
          })) {
            if (chunk.type === 'text-delta') {
              latency.firstToken ??= Math.round(performance.now() - t);
              streamedText += chunk.delta;
            }
            if (chunk.type === 'error') throw streamError ?? new Error(chunk.errorText);
            writer.write(chunk);
          }

          const usage = await result.totalUsage;
          const providerMetadata = await result.providerMetadata;
          const cost = (providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)
            ?.usage?.cost;
          const msgUsage: MessageUsage = {
            model: this.models.ids.chat,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costUsd: typeof cost === 'number' ? cost : null,
          };
          tokens += msgUsage.inputTokens + msgUsage.outputTokens;
          const validated = validateCitations(streamedText, sources);
          if (validated.invalidMarkers.length) {
            this.logger.warn(
              `invalid_citation markers=${validated.invalidMarkers.join(',')} message=${messageId}`,
            );
          }
          latency.total = Math.round(performance.now() - t0);
          await save({
            content: validated.text,
            status: 'complete',
            citations: validated.citations,
            usage: msgUsage,
            latencyMs: latency,
            retrievedChunkIds: retrieval.chunks.map((c) => c.chunkId),
          });
          await this.limits.recordUsage(user, tokens);
          writer.write({
            type: 'data-meta',
            data: meta({
              citations: validated.citations,
              uncited: validated.citations.length === 0,
              usage: msgUsage,
            }),
          });
          writer.write({ type: 'finish' });
        } catch (err) {
          latency.total = Math.round(performance.now() - t0);
          await save({ content: streamedText, status: 'error', latencyMs: latency }).catch(
            () => undefined,
          );
          await this.limits.recordUsage(user, tokens).catch(() => undefined);
          throw err;
        }
      },
    });
  }

  listConversations(user: AuthUser) {
    return this.database.db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.createdAt))
      .limit(50);
  }

  async getConversation(user: AuthUser, id: string) {
    const db = this.database.db;
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);
    if (!conversation) throw new NotFoundException('conversation not found');
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    return { ...conversation, messages: rows };
  }
}
