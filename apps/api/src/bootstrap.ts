import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { API_ENV, type ApiConfig } from './infra/tokens.js';

export function configureApp<T extends INestApplication>(app: T): T {
  const env = app.get<ApiConfig>(API_ENV);
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, exposedHeaders: ['Retry-After'] });
  // 0 = no proxy: req.ip is the socket address and X-Forwarded-For is ignored. Production sits behind
  // exactly one proxy (Caddy) and sets 1; trusting more hops than exist lets clients spoof req.ip.
  (app as unknown as NestExpressApplication).set('trust proxy', env.TRUST_PROXY_HOPS);
  return app;
}
