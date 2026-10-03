import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { API_ENV, type ApiConfig } from './infra/tokens.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url)); // repo-root .env in local dev
} catch {
  // in containers the environment is injected
}

const app = configureApp(await NestFactory.create(AppModule));
app.enableShutdownHooks();
await app.listen(app.get<ApiConfig>(API_ENV).PORT);
