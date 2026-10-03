import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { API_ENV, type ApiConfig } from './infra/tokens.js';

export function configureApp<T extends INestApplication>(app: T): T {
  const env = app.get<ApiConfig>(API_ENV);
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, exposedHeaders: ['Retry-After'] });
  // Behind Caddy in production: trust the first proxy hop for req.ip.
  (app as unknown as NestExpressApplication).set('trust proxy', 1);
  return app;
}
