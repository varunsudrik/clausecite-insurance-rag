import type {
  ApiEnv,
  AuthEnv,
  DbEnv,
  LlmEnv,
  RabbitEnv,
  RedisEnv,
  RetrievalEnv,
  StorageEnv,
} from '@clausecite/core';

export const API_ENV = Symbol('API_ENV');
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');
export const CACHE_REDIS = Symbol('CACHE_REDIS');
/** Resolves to the `RabbitPublisher` (lazy, reconnecting; DECISIONS 011), not a raw connection. */
export const RABBIT = Symbol('RABBIT');
export const MODELS = Symbol('MODELS');
export const RERANKER = Symbol('RERANKER');

export type ApiConfig = DbEnv &
  LlmEnv &
  RabbitEnv &
  RedisEnv &
  AuthEnv &
  StorageEnv &
  RetrievalEnv &
  ApiEnv;
