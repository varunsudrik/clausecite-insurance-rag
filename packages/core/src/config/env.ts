import { z } from 'zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );

export const dbEnv = z.object({ DATABASE_URL: z.string().min(1) });

export const llmEnv = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  CHAT_MODEL: z.string().default('anthropic/claude-haiku-4.5'),
  CHAT_FALLBACK_MODELS: csv('openai/gpt-4.1-mini'),
  REWRITE_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  RERANK_MODEL: z.string().default('cohere/rerank-v3.5'),
});

export const rabbitEnv = z.object({
  RABBITMQ_URL: z.string().min(1),
  INGEST_RETRY_DELAYS_MS: csv('10000,60000,300000').pipe(
    z.array(z.string().transform(Number).pipe(z.number().int().positive())),
  ),
});

export const redisEnv = z.object({
  REDIS_URL: z.string().min(1),
  // A separate, memory-bounded Redis for the query-embedding cache. Unset: the cache shares REDIS_URL.
  CACHE_REDIS_URL: z.string().optional(),
});

export const authEnv = z.object({
  JWT_SECRET: z.string().min(32),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  API_KEY: z.string().optional(),
  GUEST_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(50_000),
});

export const storageEnv = z.object({ STORAGE_DIR: z.string().default('./data/pdfs') });

export const retrievalEnv = z.object({
  RERANK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),
  RETRIEVAL_CANDIDATES: z.coerce.number().int().positive().default(30),
  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(6),
});

export const apiEnv = z.object({
  PORT: z.coerce.number().int().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
});

export type DbEnv = z.infer<typeof dbEnv>;
export type LlmEnv = z.infer<typeof llmEnv>;
export type RabbitEnv = z.infer<typeof rabbitEnv>;
export type RedisEnv = z.infer<typeof redisEnv>;
export type AuthEnv = z.infer<typeof authEnv>;
export type StorageEnv = z.infer<typeof storageEnv>;
export type RetrievalEnv = z.infer<typeof retrievalEnv>;
export type ApiEnv = z.infer<typeof apiEnv>;

export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // `KEY=` in a .env file yields '' - treat it as unset so defaults apply
  // (z.coerce.number() would otherwise turn '' into 0).
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
