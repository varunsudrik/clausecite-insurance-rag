// Usage: pnpm smoke:models  (reads .env). Verifies model slugs + response shapes against OpenRouter.
import { generateText } from 'ai';
import {
  EMBEDDING_DIMENSIONS,
  createModels,
  createOpenRouterReranker,
  embedQuery,
  llmEnv,
  loadEnv,
} from '@clausecite/core';

const env = loadEnv(llmEnv);
const models = createModels(env);

const chat = await generateText({ model: models.chat, prompt: 'Reply with the single word: ok' });
console.log('chat     ', env.CHAT_MODEL, '→', JSON.stringify(chat.text), chat.usage);

const vec = await embedQuery(models.embedding, 'room rent sub-limit');
console.log('embedding', env.EMBEDDING_MODEL, '→ dims', vec.length);
if (vec.length !== EMBEDDING_DIMENSIONS) {
  throw new Error(`expected ${EMBEDDING_DIMENSIONS} dims, got ${vec.length}`);
}

const reranker = createOpenRouterReranker({
  apiKey: env.OPENROUTER_API_KEY,
  model: env.RERANK_MODEL,
  baseURL: env.OPENROUTER_BASE_URL,
});
const hits = await reranker.rerank(
  'cataract waiting period',
  ['Cataract: 24 months waiting period.', 'Ambulance cover up to Rs 2000.'],
  2,
);
console.log('rerank   ', env.RERANK_MODEL, '→', hits);
if (hits[0]?.index !== 0) throw new Error('rerank ordering looks wrong');
console.log('all model checks passed');
