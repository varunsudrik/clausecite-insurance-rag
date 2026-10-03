import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url)); // repo-root .env in local dev
} catch {
  // in containers the environment is injected
}

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
